/**
 * Erros do sistema (E09, pilar 12.1): o que o web e o worker gravam em `system_errors` e quando um
 * erro vira aviso para quem administra. Regras puras; o registro está em apps/web/src/server/erros.ts
 * e apps/worker/src/operacao/erros.ts.
 *
 * O texto de um erro pode carregar dado pessoal (o Postgres cita o valor que violou uma restrição; uma
 * URL leva token ou e-mail). Antes de gravar, `limparTextoDeErro` troca o que parece dado por marcas.
 */

export type OrigemDoErro = "web" | "worker" | "operacao";

export type ErroParaRegistro = {
  origem: OrigemDoErro;
  /** Classe do erro (TypeError, código do Postgres) ou o nome da verificação. */
  nome: string;
  /** Mensagem limpa, até 500 caracteres. */
  mensagem: string;
  /** Pilha limpa, até 4000 caracteres. */
  detalhe: string | null;
  /** Onde aconteceu: rota normalizada, job, verificação. */
  local: string;
  /** Agrupa ocorrências iguais (mesma origem, nome, local e mensagem sem números). */
  assinatura: string;
};

const LIMITE_MENSAGEM = 500;
const LIMITE_DETALHE = 4000;

/** Tira dado pessoal e segredo de um texto de erro, mantendo o formato para quem investiga. */
export function limparTextoDeErro(texto: string, limite = LIMITE_MENSAGEM): string {
  const limpo = texto
    // Cabeçalhos e tokens: "Bearer xxx", "token=xxx", "key: xxx".
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <segredo>")
    .replace(/\b((?:access_|refresh_|id_)?token|secret|senha|password|apikey|api_key|key|signature)(["']?\s*[=:]\s*["']?)[^\s"'&,;)]+/gi, "$1$2<segredo>")
    // JWT e sequências longas de base64/hex (chaves, ids de sessão).
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/\b[A-Za-z0-9+_-]{32,}={0,2}/g, "<longo>")
    // Query string inteira de URLs (pode ter token, e-mail, nome).
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g, "$1?<consulta>")
    .replace(/(\/[A-Za-z0-9/_.$-]*)\?[^\s#"']*/g, "$1?<consulta>")
    // Dados pessoais comuns.
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "<cpf>")
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, "<cnpj>")
    .replace(/\+?\d[\d ()-]{8,}\d/g, "<numero>")
    // Valores citados pelo Postgres: Key (email)=(fulano@x) → Key (email)=(<valor>).
    .replace(/(\)=\()[^)]*\)/g, "$1<valor>)")
    .trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

/**
 * Caminho de uma requisição sem o que muda a cada chamada: query string, ids, tokens e números.
 * `/api/arquivos/abc123.../item9` → `/api/arquivos/:id/:id`.
 */
export function normalizarCaminho(caminho: string): string {
  const semConsulta = caminho.split(/[?#]/)[0] ?? "/";
  const partes = semConsulta.split("/").map((p) => (p === "" ? p : /\d/.test(p) || p.length > 24 || p.includes("@") ? ":id" : p));
  return partes.join("/").slice(0, 200) || "/";
}

/** Primeira linha da pilha que é do Omni (não de node_modules nem do Node), sem número de coluna. */
function primeiroLocalDoOmni(pilha: string | undefined): string {
  if (!pilha) return "";
  for (const linha of pilha.split("\n").slice(1)) {
    const l = linha.trim();
    if (!l.startsWith("at ") || l.includes("node_modules") || l.includes("node:")) continue;
    return l.replace(/:\d+(:\d+)?\)?$/, "").replace(/^at\s+/, "").slice(0, 160);
  }
  return "";
}

/** Monta o registro de um erro capturado: nome, mensagem e pilha limpos e a assinatura que agrupa. */
export function resumirErro(erro: unknown, origem: OrigemDoErro, local: string): ErroParaRegistro {
  const e = (erro ?? {}) as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } };
  const codigo = typeof e.code === "string" ? e.code : typeof e.cause?.code === "string" ? e.cause.code : "";
  const nomeBase = typeof e.name === "string" && e.name ? e.name : erro instanceof Error ? "Error" : typeof erro;
  const nome = (codigo ? `${nomeBase} ${codigo}` : nomeBase).slice(0, 80);
  // O Drizzle põe a consulta e os parâmetros (que podem ter nomes e textos) na mensagem: fica só o fato.
  const semConsulta = (t: string) => t.replace(/^Failed query:[\s\S]*/, "Falha na consulta ao banco");
  const textoCru = semConsulta(typeof e.message === "string" ? e.message : typeof erro === "string" ? erro : "");
  const causa = typeof e.cause?.message === "string" && e.cause.message !== textoCru ? ` (causa: ${e.cause.message})` : "";
  const mensagem = limparTextoDeErro(`${textoCru}${causa}` || "(sem mensagem)");
  const pilha = typeof e.stack === "string" ? e.stack : undefined;
  // A pilha começa repetindo a mensagem crua: só as linhas de código entram, depois da mensagem limpa.
  const linhasDeCodigo = pilha ? pilha.split("\n").filter((l) => /^\s+at\s/.test(l)) : [];
  const detalhe = pilha ? limparTextoDeErro([`${nome}: ${mensagem}`, ...linhasDeCodigo].join("\n"), LIMITE_DETALHE) : null;
  const ondeNoCodigo = primeiroLocalDoOmni(pilha);
  // Números mudam a cada ocorrência (ids, contagens, tempos) e não mudam o erro.
  const mensagemSemNumeros = mensagem.replace(/\d+/g, "#").slice(0, 160);
  const assinatura = [origem, nome, local, ondeNoCodigo || mensagemSemNumeros].join("|").slice(0, 400);
  return { origem, nome, mensagem, detalhe, local: local.slice(0, 200), assinatura };
}

/** Um erro novo avisa logo; o mesmo erro só avisa de novo depois de `intervaloHoras` e se voltou a acontecer. */
export function deveAvisarErro(e: { ultimaVez: Date; avisadoEm: Date | null }, agora: Date, intervaloHoras = 6): boolean {
  if (!e.avisadoEm) return true;
  return e.ultimaVez > e.avisadoEm && agora.getTime() - e.avisadoEm.getTime() >= intervaloHoras * 3_600_000;
}

// ---------------------------------------------------------------- saúde da operação (backup e ensaio)

export type StatusDeBackup = { status?: string; finishedAt?: string; uploadSucceeded?: boolean; b2Uri?: string };
export type StatusDeEnsaio = { status?: string; finishedAt?: string; message?: string };
export type ProblemaDeOperacao = { chave: string; mensagem: string };

export const LIMITES_OPERACAO = {
  /** O diário roda às 02h20 UTC; 26 h dá folga para um atraso sem deixar passar um dia sem backup. */
  backupRemotoHoras: 26,
  /** O ensaio é mensal (dia 2); 35 dias cobrem o mês mais longo e um atraso. */
  ensaioDias: 35,
} as const;

const horasDesde = (iso: string | undefined, agora: Date) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (agora.getTime() - t) / 3_600_000 : Infinity;
};

/**
 * Confere os JSON de status que deploy/backup-prod.sh e deploy/restore-drill.sh gravam.
 * `null` = arquivo ausente ou ilegível. Mesmos limites do filtroAPP (26 h e 35 dias).
 */
export function avaliarOperacao(
  s: { ultimoBackup: StatusDeBackup | null; backupRemoto: StatusDeBackup | null; ensaio: StatusDeEnsaio | null },
  agora: Date,
): ProblemaDeOperacao[] {
  const problemas: ProblemaDeOperacao[] = [];
  if (s.ultimoBackup?.status === "FAILURE") {
    problemas.push({ chave: "backup:falhou", mensagem: "A última execução do backup falhou. Veja ~/logs/backup-omni.log na VPS." });
  }
  const remoto = s.backupRemoto;
  if (!remoto) {
    problemas.push({ chave: "backup:sem-remoto", mensagem: "Não há registro de backup enviado ao B2." });
  } else if (remoto.status !== "SUCCESS" || remoto.uploadSucceeded !== true) {
    problemas.push({ chave: "backup:remoto-falhou", mensagem: "O último envio de backup ao B2 falhou." });
  } else if (horasDesde(remoto.finishedAt, agora) > LIMITES_OPERACAO.backupRemotoHoras) {
    const h = Math.floor(horasDesde(remoto.finishedAt, agora));
    problemas.push({ chave: "backup:remoto-velho", mensagem: `O último backup no B2 tem ${h} horas (limite ${LIMITES_OPERACAO.backupRemotoHoras}).` });
  }
  const ensaio = s.ensaio;
  if (!ensaio) {
    problemas.push({ chave: "ensaio:ausente", mensagem: "Não há registro de ensaio de restauração." });
  } else if (ensaio.status !== "SUCCESS") {
    problemas.push({ chave: "ensaio:falhou", mensagem: `O último ensaio de restauração falhou${ensaio.message ? `: ${limparTextoDeErro(ensaio.message, 200)}` : "."}` });
  } else if (horasDesde(ensaio.finishedAt, agora) > LIMITES_OPERACAO.ensaioDias * 24) {
    const d = Math.floor(horasDesde(ensaio.finishedAt, agora) / 24);
    problemas.push({ chave: "ensaio:velho", mensagem: `O último ensaio de restauração tem ${d} dias (limite ${LIMITES_OPERACAO.ensaioDias}).` });
  }
  return problemas;
}
