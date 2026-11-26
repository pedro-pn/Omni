import { readFileSync } from "node:fs";

import { createPool, createWorkerDb } from "@omni/db";
import { FiltroAppClient } from "@omni/integrations/filtroapp";
import { GraphClient } from "@omni/integrations/graph";
import { EvolutionClient, PonteDeAcoes } from "@omni/integrations/whatsapp";
import { PrismaClient } from "@omni/integrations/prisma";
import { PgBoss } from "pg-boss";

import { carregarCalendario } from "./calendario.ts";
import { loadWorkerEnv } from "./env.ts";
import { planejarAgenda, publicarPerguntas } from "./ia/agenda.ts";
import { enviarDescargas } from "./ia/descargas.ts";
import { enviarDesvios } from "./ia/desvios.ts";
import { lerRdos } from "./ia/leitura-rdos.ts";
import { processarEventos } from "./sync/filtroapp-eventos.ts";
import { syncMissoes } from "./sync/filtroapp-missoes.ts";
import { registrarAvanco, syncEntregaB, type RecursoEntregaB } from "./sync/filtroapp-entrega-b.ts";
import { syncCustos, syncSemanas, syncServicos } from "./sync/filtroapp-gestao.ts";
import { syncEmails } from "./sync/outlook-emails.ts";
import { apagarTodasAsAssinaturas, manterAssinaturas, ouvirAvisosDoGraph } from "./sync/graph-avisos.ts";
import { resumirReunioes, syncReunioes } from "./sync/teams-reunioes.ts";
import { conferirAlertas, publicarDisparos } from "./ia/alertas.ts";
import { enviadorWebPush } from "./push/enviar.ts";
import { ouvirEventosDePush } from "./push/eventos.ts";
import { conferirNumeros } from "./whatsapp/estado.ts";
import { sincronizarPessoasDoEntra } from "./entra/pessoas.ts";
import { recuperarRecentes } from "./whatsapp/historico.ts";
import { atualizarPerfis } from "./whatsapp/perfis.ts";
import { lerAgendas } from "./whatsapp/agenda.ts";
import { syncPrismaComercial } from "./sync/prisma-comercial.ts";
import { syncRelatorios } from "./sync/filtroapp-relatorios.ts";
import { enviarLembretes } from "./tarefas/lembretes.ts";
import { buscarAudioNoServico, resumirChamadas, apagarAudioNoServico, type DepsResumoChamadas } from "./chamadas/resumo.ts";
import { arquivarGravacoes } from "./chamadas/arquivar.ts";
import { chaveMestra, decifrarGravacao, desembrulharChave } from "@omni/integrations/gravacoes";
import { ffmpegDisponivel, m4aParaWavMono, wavParaM4a } from "./chamadas/ffmpeg.ts";
import { detectarChegadas } from "./ia/chegadas.ts";
import { lerAssinaturas } from "./ia/assinaturas.ts";
import { vincularPelasAssinaturas } from "./contatos/assinaturas.ts";
import { enviarAvisosPorEmail, enviarResumoSemanal, type EnviarEmail } from "./tarefas/emails.ts";
import { vigiarRiscos } from "./seguranca/riscos.ts";
import { aplicarRetencao } from "./operacao/retencao.ts";
import { registrarSaude } from "./operacao/saude.ts";
import { avisarErros, conferirOperacao, registrarErroDoWorker } from "./operacao/erros.ts";
import { conferidorDoTeto, openAiComTeto } from "./operacao/teto-ia.ts";

/**
 * Worker do Omni. Filas pg-boss com política `exclusive` (nunca duas execuções
 * da mesma tarefa ao mesmo tempo):
 *   filtroapp-eventos   2 min   feed do filtroAPP → dispara missões/relatórios
 *   filtroapp-missoes  30 min   rede de segurança (completo 1×/dia)
 *   filtroapp-relatorios 30 min rede de segurança (completo 1×/dia)
 *   filtroapp-entrega-b 30 min  medição, notas, romaneios, pendências, descargas, Qualidade,
 *                               condições e alocações (completo 1×/dia)
 *   filtroapp-semanas  30 min   avanço, meta e revisão por semana; horas do ponto (últimas 4 semanas)
 *   filtroapp-custos   1×/dia   custos × avanço (06:20; cálculo pesado no filtroAPP)
 *   filtroapp-servicos  1 h     composição do avanço por serviço e equipamento (cartões do detalhe do projeto)
 *   ia-planejar        15 min   cria/cancela perguntas da IA
 *   ia-publicar         5 min   publica no Interno, só seg–sex 08–18h fora de feriados
 *   ia-desvios          2 min   desvios à Qualidade conforme FILTROAPP_ESCRITA
 *   ia-descargas        2 min   confirmações de descarga ao filtroAPP conforme FILTROAPP_ESCRITA
 *   tarefas-lembretes   1 min   lembretes das tarefas no sino
 *   prisma-comercial   10 min   Prisma: empresas, oportunidades, missões e pastas do SharePoint (eventos +
 *                               updated_since; completo 1×/dia), só leitura com o `reader`
 *   outlook-emails      5 min   e-mails das caixas cadastradas que se ligam a missões (Graph, delta); na hora, com o aviso do Graph
 *   graph-avisos       30 min  assinaturas de aviso do Graph (e-mail novo na Entrada), com EMAIL_AVISO_IMEDIATO=ligado
 *   entra-pessoas       1 h     quem está atribuído ao app "Omni" no Entra → Pessoas; quem sai é desativado
 *   teams-reunioes     15 min  agenda das caixas: reuniões ligadas a missões; transcrição → resumo (IA_RESUMO_REUNIAO) no Gerencial
 *   whatsapp-estado     5 min  confere na Evolution do Omni o estado dos números (o webhook avisa na hora)
 *   retencao           03:40   retenção por tipo de dado (RETENCAO: ensaio só conta, real apaga e apaga de vez no SharePoint os arquivos vencidos)
 *   riscos             10 min  alertas de risco: download em massa e arquivos enviados para fora (Administração e diretoria)
 *   alertas-erros       5 min  erros do sistema novos (ou que voltaram depois de 6 h) → aviso no sino e no celular de quem é admin
 *   saude               5 min  painel de saúde: versão e memória do worker e o status do backup (Administração → Saúde)
 *   saude-operacao      1 h    status do backup e do ensaio de restauração (OPERACAO_STATUS=ligado) → erro do sistema se passar do limite
 *   whatsapp-recuperar 10 min  relê as últimas 2 h na Evolution e grava o que o webhook perdeu
 *   whatsapp-perfis    30 min  nome dos grupos e endereço da foto das conversas (lista da Evolution)
 *   whatsapp-agenda    6 h     contatos salvos na agenda do celular (ponte de ações; 0088)
 *   chamadas-arquivar   2 min  gravações → M4A cifrado no SharePoint (OmniAnexos); apaga de vez as excluídas/vencidas
 *   ia-alertas         15 min  alertas pedidos à IA (@IA, /alerta): lê RDOs novos (IA_ALERTAS) e publica disparos na janela útil
 *   ia-assinaturas     30 min  nome, cargo e empresa dos remetentes externos pela assinatura (IA_ASSINATURAS; texto não guardado)
 *   agenda-assinaturas 30 min  telefone da assinatura ligado ao e-mail na agenda da empresa (caixa única, 0068; só acrescenta)
 *   ia-chegadas         5 min  "chegamos" no grupo do WhatsApp de missão que não começou em campo → pergunta ao líder de projetos
 *   avisos-email        2 min  avisos de tarefa não lidos num e-mail por pessoa (EMAIL_ENVIO; fora da produção, ensaio)
 *   resumo-atrasadas  seg 09h  e-mail das atividades em atraso de cada pessoa
 *   resumo-semana     seg 14h  e-mail das atividades previstas da semana
 *   chamadas-resumo     1 min  ligações gravadas cujo dono pediu o resumo: transcrição e resumo pela OpenAI (IA_RESUMO_CHAMADA); a transcrição não é guardada
 *   (ouvinte)                 notificações no celular (Web Push): avisos, mensagens dos canais e do WhatsApp
 *   ia-leitura-rdos  07:00 seg–sáb  regras do regime + leitura do texto pelo LLM (IA_LEITURA_RDO) → pergunta no Interno
 */

const env = loadWorkerEnv();
const pool = createPool(env.DATABASE_URL_WORKER, 4);
const db = createWorkerDb(pool);

const boss = new PgBoss({ connectionString: env.DATABASE_URL_WORKER, schema: "pgboss", application_name: "omni-worker" });
boss.on("error", (error) => console.error("[pg-boss]", error.message));
await boss.start();
console.log(`[worker] versão ${process.env.OMNI_VERSAO || "desconhecida"}`);

// Erros fora dos jobs (promessa sem tratamento, exceção no processo): registrados antes de sair.
process.on("unhandledRejection", (motivo) => {
  console.error("[worker] promessa rejeitada sem tratamento:", motivo);
  void registrarErroDoWorker(db, motivo, "processo");
});
process.on("uncaughtException", (erro) => {
  console.error("[worker] exceção não tratada:", erro);
  void registrarErroDoWorker(db, erro, "processo").finally(() => process.exit(1));
});

// Teto diário da IA (E11): todo cliente da OpenAI do worker confere o gasto do dia antes de chamar.
const tetoIa = conferidorDoTeto(db, { tokens: env.IA_TETO_TOKENS_DIA, chamadas: env.IA_TETO_CHAMADAS_DIA });

const log = (job: string, dados: object) => console.log(JSON.stringify({ job, at: new Date().toISOString(), ...dados }));

/**
 * Execuções que ficaram "ativas" de um worker que parou no meio (reinício,
 * deploy) travariam a fila exclusiva até expirar (15 min). O worker roda numa
 * instância só, então na partida elas são dadas como falhas e a política de
 * novas tentativas as recoloca.
 */
async function liberarOrfas(nome: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM pgboss.job WHERE name = $1 AND state = 'active'", [nome]);
  if (rows.length) await boss.fail(nome, rows.map((r) => r.id), { motivo: "worker reiniciado no meio da execução" });
  return rows.length;
}

async function tarefa(nome: string, cron: string, fn: () => Promise<object>, iniciarAgora = true) {
  await boss.createQueue(nome, { policy: "exclusive", retryLimit: 2, retryDelay: 60, expireInSeconds: 15 * 60 });
  const orfas = await liberarOrfas(nome);
  if (orfas) log(nome, { orfasLiberadas: orfas });
  await boss.work(nome, async () => {
    try {
      log(nome, await fn());
    } catch (error) {
      // Erro do sistema (E09): fica registrado e avisa quem administra; o pg-boss tenta de novo.
      await registrarErroDoWorker(db, error, nome);
      throw error;
    }
  });
  await boss.schedule(nome, cron, null, { tz: env.TZ_EMPRESA });
  if (iniciarAgora) await boss.send(nome, null);
}

// Tarefas que saíram do worker: o agendamento fica gravado no pg-boss e criaria jobs sem quem os execute.
// whatsapp-historico: o histórico do WhatsApp passou a ser baixado só para o aparelho do dono (12/11/2026).
for (const antiga of ["whatsapp-historico"]) await boss.unschedule(antiga).catch(() => undefined);

const filtroapp = env.FILTROAPP_API_TOKEN
  ? new FiltroAppClient({ baseUrl: env.FILTROAPP_API_URL, token: env.FILTROAPP_API_TOKEN, escrita: env.FILTROAPP_ESCRITA })
  : null;

// Filas da IA primeiro: as sincronizações acionam o replanejamento.
await tarefa("ia-planejar", "*/15 * * * *", async () => planejarAgenda(db, await carregarCalendario(db, env.TZ_EMPRESA)), !filtroapp);
await tarefa("ia-publicar", "*/5 * * * *", async () => publicarPerguntas(db, await carregarCalendario(db, env.TZ_EMPRESA)));
await tarefa("tarefas-lembretes", "* * * * *", () => enviarLembretes(db));
// Alertas de risco (Fase 11): download em massa e envio de arquivos para fora.
await tarefa("riscos", "*/10 * * * *", () => vigiarRiscos(db), false);

// Erros do sistema (E09): aviso a quem administra e conferência do backup.
await tarefa("alertas-erros", "*/5 * * * *", () => avisarErros(db), false);
// Painel de saúde (E20): o worker e o status do backup, para Administração → Saúde.
await tarefa("saude", "*/5 * * * *", () => registrarSaude(db, env.OPERACAO_STATUS === "ligado" ? env.OPERACAO_STATUS_DIR : null));
if (env.OPERACAO_STATUS === "ligado") {
  await tarefa("saude-operacao", "35 * * * *", () => conferirOperacao(db, env.OPERACAO_STATUS_DIR));
} else {
  console.warn("[worker] OPERACAO_STATUS desligado: o status do backup não é conferido");
}
await tarefa(
  "ia-desvios",
  "*/2 * * * *",
  async () => enviarDesvios(db, filtroapp, await carregarCalendario(db, env.TZ_EMPRESA)),
  false,
);

await tarefa(
  "ia-descargas",
  "*/2 * * * *",
  async () => enviarDescargas(db, filtroapp, await carregarCalendario(db, env.TZ_EMPRESA)),
  false,
);

// Depois de cada sincronização, replaneja a IA com os dados novos (datas, etapas, RDOs).
const replanejar = () => boss.send("ia-planejar", null);

if (filtroapp) {
  const missoes = async () => {
    const r = await syncMissoes(db, filtroapp);
    await registrarAvanco(db, await carregarCalendario(db, env.TZ_EMPRESA));
    await replanejar();
    return r;
  };
  const relatorios = async (opcoes?: { forcarCompleta?: boolean }) => {
    const r = await syncRelatorios(db, filtroapp, opcoes);
    await replanejar();
    return r;
  };
  const entregaB = async (opcoes: { recursos?: RecursoEntregaB[]; forcarCompleta?: boolean } = {}) => {
    const r = await syncEntregaB(db, filtroapp, opcoes);
    await replanejar();
    return r;
  };
  await tarefa("filtroapp-missoes", "*/30 * * * *", missoes);
  await tarefa("filtroapp-relatorios", "*/30 * * * *", () => relatorios());
  await tarefa("filtroapp-entrega-b", "5,35 * * * *", () => entregaB());
  const semanas = async () => syncSemanas(db, filtroapp, await carregarCalendario(db, env.TZ_EMPRESA));
  await tarefa("filtroapp-semanas", "15,45 * * * *", semanas);
  await tarefa("filtroapp-custos", "20 6 * * *", () => syncCustos(db, filtroapp));
  // Composição do avanço por serviço (cartões do detalhe do projeto): de hora em hora.
  await tarefa("filtroapp-servicos", "25 * * * *", () => syncServicos(db, filtroapp));
  await tarefa(
    "filtroapp-eventos",
    "*/2 * * * *",
    () => processarEventos(db, filtroapp, { missoes, relatorios, entregaB, semanas: () => boss.send("filtroapp-semanas", null) }),
    false,
  );
} else {
  console.warn("[worker] FILTROAPP_API_TOKEN não definido: sincronização com o filtroAPP desligada");
}

if (env.PRISMA_OMNI_READER_TOKEN) {
  const prisma = new PrismaClient({ token: env.PRISMA_OMNI_READER_TOKEN, environment: env.PRISMA_OMNI_ENVIRONMENT });
  await tarefa("prisma-comercial", "*/10 * * * *", () => syncPrismaComercial(db, prisma));
} else {
  console.warn("[worker] PRISMA_OMNI_READER_TOKEN não definido: pastas comerciais do Prisma desligadas");
}

let enviarPeloGraph: EnviarEmail | null = null;
let graphGeral: GraphClient | null = null;
let pararAvisosGraph: (() => Promise<void>) | null = null;
if (env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_PRIVATE_KEY_PATH && env.GRAPH_CERT_SHA256_THUMBPRINT) {
  const graph = new GraphClient({
    tenantId: env.GRAPH_TENANT_ID,
    clientId: env.GRAPH_CLIENT_ID,
    privateKeyPem: readFileSync(env.GRAPH_PRIVATE_KEY_PATH, "utf8"),
    thumbprintSha256: env.GRAPH_CERT_SHA256_THUMBPRINT,
  });
  graphGeral = graph;
  const remetente = env.EMAIL_AVISOS_REMETENTE;
  if (remetente) enviarPeloGraph = (para, e) => graph.enviarEmail(remetente, { assunto: e.assunto, texto: e.texto, html: e.html, para: [para], cc: [], cco: [] });
  await tarefa("outlook-emails", "*/5 * * * *", () => syncEmails(db, graph));
  // Aviso imediato (0070): o Graph avisa o web, que acorda o worker; a leitura de 5 min continua como rede.
  if (env.EMAIL_AVISO_IMEDIATO === "ligado") {
    const urlAvisos = new URL("/api/graph/avisos", env.APP_ORIGIN).toString();
    await tarefa("graph-avisos", "*/30 * * * *", () => manterAssinaturas(db, graph, urlAvisos));
    const lerAgora = async (tentativa = 0) => {
      // Fila exclusiva: com uma leitura já na fila ou rodando, tenta de novo logo depois.
      const id = await boss.send("outlook-emails", null).catch(() => null);
      if (!id && tentativa < 3) setTimeout(() => void lerAgora(tentativa + 1), 20_000);
    };
    pararAvisosGraph = ouvirAvisosDoGraph(env.DATABASE_URL_WORKER, () => void lerAgora());
  } else {
    // Desligado: as assinaturas antigas saem (o Graph pararia de chamar sozinho em até 3 dias).
    void apagarTodasAsAssinaturas(db, graph).catch(() => undefined);
  }
  // Pessoas liberadas no app "Omni" do Entra → lista de Pessoas (0049)
  const appLogin = env.ENTRA_CLIENT_ID;
  if (appLogin) await tarefa("entra-pessoas", "12 * * * *", () => sincronizarPessoasDoEntra(db, graph, appLogin));
  else console.warn("[worker] ENTRA_CLIENT_ID não definido: a lista de Pessoas não é lida do Entra");
  if (env.IA_ASSINATURAS === "ligada" && env.OPENAI_API_KEY) {
    const llmAssinaturas = openAiComTeto(env.OPENAI_API_KEY, tetoIa);
    const ler = async (caixa: string, id: string) => (await graph.mensagem(caixa, id)).body?.content ?? null;
    await tarefa("ia-assinaturas", "7,37 * * * *", () => lerAssinaturas(db, ler, llmAssinaturas, { modelo: env.OPENAI_MODEL }));
  }
  // Caixa única: o telefone conferido na assinatura liga o e-mail ao WhatsApp do contato.
  await tarefa("agenda-assinaturas", "17,47 * * * *", () => vincularPelasAssinaturas(db));
  const llmReunioes = env.IA_RESUMO_REUNIAO === "ligada" && env.OPENAI_API_KEY ? openAiComTeto(env.OPENAI_API_KEY, tetoIa) : null;
  await tarefa("teams-reunioes", "3,18,33,48 * * * *", async () => ({
    agenda: await syncReunioes(db, graph),
    resumos: await resumirReunioes(db, graph, llmReunioes, await carregarCalendario(db, env.TZ_EMPRESA), { modelo: env.OPENAI_MODEL }),
  }));
} else {
  console.warn("[worker] Graph não configurado (GRAPH_*): e-mails das missões desligados");
}

// Retenção por tipo de dado (0066, 0081): todo dia às 03:40; prazos em app.aplicar_retencao. Com
// RETENCAO=real, os arquivos vencidos no SharePoint são apagados de vez (operacao/retencao.ts).
const modoRetencao = env.RETENCAO;
if (modoRetencao !== "desligada") {
  await tarefa("retencao", "40 3 * * *", () => aplicarRetencao(db, modoRetencao, graphGeral), false);
}

if (env.WHATSAPP_EVOLUTION_URL && env.WHATSAPP_EVOLUTION_KEY) {
  const evolution = new EvolutionClient({ url: env.WHATSAPP_EVOLUTION_URL, chave: env.WHATSAPP_EVOLUTION_KEY });
  await tarefa("whatsapp-estado", "*/5 * * * *", () => conferirNumeros(db, evolution));
  await tarefa("whatsapp-recuperar", "*/10 * * * *", () => recuperarRecentes(db, evolution));
  await tarefa("whatsapp-perfis", "*/30 * * * *", () => atualizarPerfis(db, evolution));
  // Agenda do celular (0088): só com a ponte de ações ligada na Evolution.
  if (env.WHATSAPP_ACOES_URL && env.WHATSAPP_ACOES_TOKEN) {
    const ponte = new PonteDeAcoes({ url: env.WHATSAPP_ACOES_URL, token: env.WHATSAPP_ACOES_TOKEN });
    await tarefa("whatsapp-agenda", "20 */6 * * *", () => lerAgendas(db, ponte));
  }
} else {
  console.warn("[worker] WhatsApp não configurado (WHATSAPP_EVOLUTION_*): conferência dos números desligada");
}

// Leitura dos RDOs: as regras do regime rodam sempre; o LLM só com IA_LEITURA_RDO=ligada e a chave.
const llm = env.IA_LEITURA_RDO === "ligada" && env.OPENAI_API_KEY ? openAiComTeto(env.OPENAI_API_KEY, tetoIa) : null;
await tarefa(
  "ia-leitura-rdos",
  "0 7 * * 1-6",
  async () => lerRdos(db, llm, await carregarCalendario(db, env.TZ_EMPRESA), { modelo: env.OPENAI_MODEL }),
  false,
);

// Alertas pedidos à IA: a leitura usa o LLM (IA_ALERTAS); os disparos já decididos são publicados sempre.
const llmAlertas = env.IA_ALERTAS === "ligada" && env.OPENAI_API_KEY ? openAiComTeto(env.OPENAI_API_KEY, tetoIa) : null;
await tarefa("ia-alertas", "*/15 * * * *", async () => ({
  conferencia: llmAlertas ? await conferirAlertas(db, llmAlertas, { modelo: env.OPENAI_MODEL }) : "IA_ALERTAS desligada",
  publicacao: await publicarDisparos(db, await carregarCalendario(db, env.TZ_EMPRESA)),
}));

// Chegada da equipe pelo grupo do WhatsApp: só frases, sem LLM (a publicação segue a janela útil).
await tarefa("ia-chegadas", "*/5 * * * *", async () => detectarChegadas(db, await carregarCalendario(db, env.TZ_EMPRESA)));

// Avisos das tarefas por e-mail e resumo semanal (porta do Foco). "real" só na produção e com a caixa remetente.
if (env.EMAIL_ENVIO !== "desligado") {
  const modo = env.EMAIL_ENVIO === "real" && enviarPeloGraph ? "real" : "ensaio";
  if (env.EMAIL_ENVIO === "real" && !enviarPeloGraph) console.warn("[worker] EMAIL_ENVIO=real sem Graph ou EMAIL_AVISOS_REMETENTE: avisos por e-mail em ensaio");
  const opcoes = { modo, app: env.APP_ORIGIN.replace(/\/$/, ""), enviar: enviarPeloGraph } as const;
  const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: env.TZ_EMPRESA });
  await tarefa("avisos-email", "*/2 * * * *", () => enviarAvisosPorEmail(db, opcoes));
  await tarefa("resumo-atrasadas", "0 9 * * 1", () => enviarResumoSemanal(db, opcoes, "atrasadas", hoje()), false);
  await tarefa("resumo-semana", "0 14 * * 1", () => enviarResumoSemanal(db, opcoes, "semana", hoje()), false);
}

// Gravações das ligações no SharePoint (0052): comprime em M4A e envia ao site OmniAnexos.
const ffmpegOk = env.CHAMADAS_SERVICO_URL && env.CHAMADAS_SERVICO_KEY ? await ffmpegDisponivel() : false;
const mestraGravacoes = env.GRAVACOES_CHAVE_MESTRA ? chaveMestra(env.GRAVACOES_CHAVE_MESTRA) : null;
if (graphGeral && env.GRAPH_ANEXOS_DRIVE_ID && env.CHAMADAS_SERVICO_URL && env.CHAMADAS_SERVICO_KEY && ffmpegOk && mestraGravacoes) {
  const deps = {
    buscarWav: buscarAudioNoServico(env.CHAMADAS_SERVICO_URL, env.CHAMADAS_SERVICO_KEY),
    apagarDoServico: apagarAudioNoServico(env.CHAMADAS_SERVICO_URL, env.CHAMADAS_SERVICO_KEY),
    comprimir: (wav: Uint8Array) => wavParaM4a(wav),
    sharepoint: graphGeral,
    driveId: env.GRAPH_ANEXOS_DRIVE_ID,
    mestra: mestraGravacoes,
    pasta: (env.OMNI_AMBIENTE ?? (env.NODE_ENV === "production" ? "producao" : "desenvolvimento")) === "producao" ? "Gravacoes" : `Gravacoes-${env.OMNI_AMBIENTE ?? "desenvolvimento"}`,
  };
  await tarefa("chamadas-arquivar", "*/2 * * * *", () => arquivarGravacoes(db, deps));
} else if (env.CHAMADAS_SERVICO_URL) {
  const falta = !graphGeral ? "Graph" : !env.GRAPH_ANEXOS_DRIVE_ID ? "GRAPH_ANEXOS_DRIVE_ID" : !mestraGravacoes ? "GRAVACOES_CHAVE_MESTRA" : "ffmpeg";
  console.warn(`[worker] gravações ficam no serviço de voz (sem ${falta}): não vão ao SharePoint`);
}

// Resumo das ligações gravadas: precisa da IA ligada, da chave da OpenAI e do serviço de voz.
if (env.IA_RESUMO_CHAMADA === "ligada" && env.OPENAI_API_KEY && env.CHAMADAS_SERVICO_URL && env.CHAMADAS_SERVICO_KEY) {
  const openai = openAiComTeto(env.OPENAI_API_KEY, tetoIa);
  const doServico = buscarAudioNoServico(env.CHAMADAS_SERVICO_URL, env.CHAMADAS_SERVICO_KEY);
  const sp = graphGeral;
  // Já arquivada: M4A do SharePoint → WAV mono para a transcrição.
  const buscarAudio: DepsResumoChamadas["buscarAudio"] = async (c) => {
    if (c.arquivoLocal !== "sharepoint") return doServico(c);
    if (!sp || !c.spDriveId || !c.spItemId || !c.chaveCifrada || !mestraGravacoes || !ffmpegOk) return null;
    const cifrado = new Uint8Array(await (await sp.baixar(c.spDriveId, c.spItemId)).arrayBuffer());
    const m4a = decifrarGravacao(cifrado, desembrulharChave(c.chaveCifrada, mestraGravacoes, c.id));
    return m4aParaWavMono(m4a);
  };
  await tarefa("chamadas-resumo", "* * * * *", async () =>
    resumirChamadas(db, { buscarAudio, transcritor: openai, llm: openai, modelo: env.OPENAI_MODEL, modeloTranscricao: env.OPENAI_TRANSCRICAO_MODEL }),
  );
}

// Notificações no celular (Web Push): só com as chaves VAPID.
let pararPush: (() => Promise<void>) | null = null;
if (env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY) {
  const enviar = enviadorWebPush({ publica: env.WEB_PUSH_PUBLIC_KEY, privada: env.WEB_PUSH_PRIVATE_KEY, assunto: env.WEB_PUSH_SUBJECT });
  pararPush = ouvirEventosDePush(env.DATABASE_URL_WORKER, db, enviar, (m) => console.warn(m));
} else {
  console.warn("[worker] WEB_PUSH_* não definido: notificações no celular desligadas");
}

console.log(`[worker] pronto · escrita no filtroAPP: ${env.FILTROAPP_ESCRITA} · Prisma: ${env.PRISMA_OMNI_ENVIRONMENT} · leitura de RDO pelo LLM: ${llm ? env.OPENAI_MODEL : "desligada"}`);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal}: encerrando`);
  await pararPush?.();
  await pararAvisosGraph?.();
  await boss.stop({ graceful: true, timeout: 20_000 });
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
