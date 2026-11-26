/**
 * Limite de requisições (E10, pilar 10.1). Contagem por janela fixa, em memória do processo web (o
 * Omni roda um web só; com mais de um, cada um conta o seu e o limite efetivo multiplica).
 *
 * - Rotas públicas ou de login: por IP.
 * - Teto geral contra enxurrada: por sessão (no escritório várias pessoas saem pelo mesmo IP) e,
 *   sem sessão, por IP.
 * - Ações caras (IA, envio de mensagens, Prisma, chaves): por sessão e por função.
 */

export type RegraDeLimite = { nome: string; max: number; janelaMs: number };

const MIN = 60_000;
const HORA = 60 * MIN;

/** Rotas com limite próprio, por IP. A primeira que casar vale; webhooks internos ficam de fora. */
const ROTAS: Array<{ casa: (caminho: string) => boolean; regra: RegraDeLimite }> = [
  { casa: (c) => c.startsWith("/auth/"), regra: { nome: "login", max: 20, janelaMs: MIN } },
  { casa: (c) => c.startsWith("/api/v1/"), regra: { nome: "api-v1", max: 120, janelaMs: MIN } },
  { casa: (c) => c.startsWith("/api/prisma-authorization/") || c.startsWith("/integracoes/prisma/"), regra: { nome: "prisma-autorizacao", max: 30, janelaMs: MIN } },
  { casa: (c) => c.startsWith("/api/calendar/"), regra: { nome: "agenda-ics", max: 60, janelaMs: MIN } },
  { casa: (c) => c.startsWith("/api/graph/avisos"), regra: { nome: "graph-avisos", max: 1200, janelaMs: MIN } },
];

/** Envios de arquivo, por sessão. */
const UPLOADS = ["/api/whatsapp/arquivo", "/api/canais/arquivo", "/api/tarefas/anexo"];
export const LIMITE_UPLOAD: RegraDeLimite = { nome: "upload", max: 30, janelaMs: MIN };

export const LIMITE_GERAL_SESSAO: RegraDeLimite = { nome: "geral-sessao", max: 600, janelaMs: MIN };
export const LIMITE_GERAL_ANONIMO: RegraDeLimite = { nome: "geral-anonimo", max: 300, janelaMs: MIN };

/** Chamadas de serviços internos (com segredo próprio) e o que o navegador busca sozinho. */
export function semLimite(caminho: string): boolean {
  return (
    caminho === "/api/saude" ||
    caminho.startsWith("/api/whatsapp/webhook") ||
    caminho.startsWith("/api/chamadas/eventos") ||
    caminho.startsWith("/assets/") ||
    caminho.startsWith("/marca/") ||
    caminho.startsWith("/icones/") ||
    caminho === "/sw.js" ||
    caminho === "/manifest.webmanifest" ||
    caminho === "/favicon.ico"
  );
}

export function regraDaRota(caminho: string): RegraDeLimite | null {
  for (const r of ROTAS) if (r.casa(caminho)) return r.regra;
  if (UPLOADS.some((u) => caminho === u || caminho.startsWith(`${u}/`))) return null; // uploads: por sessão (abaixo)
  return null;
}

export function ehUpload(metodo: string, caminho: string): boolean {
  return metodo === "POST" && UPLOADS.includes(caminho);
}

/** Server functions caras, pelo nome da função (o mesmo do código). Todas as regras da lista valem. */
export const LIMITES_FUNCOES: Record<string, RegraDeLimite[]> = {
  // IA
  criarAlertaPorComando: [{ nome: "ia-alerta", max: 10, janelaMs: MIN }, { nome: "ia-alerta-hora", max: 60, janelaMs: HORA }],
  pedirResumoChamada: [{ nome: "ia-resumo-chamada", max: 10, janelaMs: HORA }],
  // Mensagens que saem para fora
  enviarMensagemWhatsApp: [{ nome: "whatsapp-envio", max: 30, janelaMs: MIN }],
  enviarEmailDaMissao: [{ nome: "email-envio", max: 10, janelaMs: MIN }],
  enviarDaMinhaCaixa: [{ nome: "email-envio", max: 10, janelaMs: MIN }],
  conectarMeuWhatsApp: [{ nome: "whatsapp-conectar", max: 5, janelaMs: MIN }],
  // Prisma (escreve no CRM em nome de quem clicou)
  registrarNoPrisma: [{ nome: "prisma-escrita", max: 30, janelaMs: MIN }],
  registrarNoPrismaEmLote: [{ nome: "prisma-lote", max: 5, janelaMs: MIN }],
  enviarParticipanteAoPrisma: [{ nome: "prisma-escrita", max: 30, janelaMs: MIN }],
  enviarContatoAoPrisma: [{ nome: "prisma-escrita", max: 30, janelaMs: MIN }],
  // Credenciais
  criarChave: [{ nome: "chave-api", max: 5, janelaMs: MIN }],
  // Login interno (0078): o banco já limita a recuperação e a confirmação por conta; aqui, por IP/sessão.
  pedirRecuperacaoDeSenha: [{ nome: "senha-recuperar", max: 5, janelaMs: MIN }, { nome: "senha-recuperar-hora", max: 20, janelaMs: HORA }],
  pedirConfirmacaoDeEmail: [{ nome: "senha-email", max: 5, janelaMs: MIN }],
  lerLinkInterno: [{ nome: "senha-link", max: 30, janelaMs: MIN }],
  usarLinkDeSenha: [{ nome: "senha-link", max: 30, janelaMs: MIN }],
  confirmarEmailPeloLink: [{ nome: "senha-link", max: 30, janelaMs: MIN }],
  trocarMinhaSenha: [{ nome: "senha-trocar", max: 10, janelaMs: MIN }],
  criarAcessoInterno: [{ nome: "acesso-interno", max: 20, janelaMs: MIN }],
  novoLinkDeSenha: [{ nome: "acesso-interno", max: 20, janelaMs: MIN }],
};

export type ResultadoDoLimite = { ok: boolean; esperarSegundos: number; primeiroBloqueio: boolean };

/** Contador por janela fixa, em memória. `agora` injetável para os testes. */
export class Limitador {
  private readonly contagens = new Map<string, { inicio: number; n: number; bloqueado: boolean }>();

  constructor(private readonly agora: () => number = () => Date.now()) {}

  usar(chave: string, regra: RegraDeLimite): ResultadoDoLimite {
    const t = this.agora();
    const k = `${regra.nome}|${chave}`;
    let c = this.contagens.get(k);
    if (!c || t - c.inicio >= regra.janelaMs) {
      c = { inicio: t, n: 0, bloqueado: false };
      this.contagens.set(k, c);
      if (this.contagens.size > 50_000) this.limpar(t);
    }
    c.n += 1;
    if (c.n <= regra.max) return { ok: true, esperarSegundos: 0, primeiroBloqueio: false };
    const primeiroBloqueio = !c.bloqueado;
    c.bloqueado = true;
    return { ok: false, esperarSegundos: Math.max(1, Math.ceil((c.inicio + regra.janelaMs - t) / 1000)), primeiroBloqueio };
  }

  /** Tira as janelas vencidas (a maior janela usada é de 1 hora). */
  limpar(t = this.agora()): void {
    for (const [k, c] of this.contagens) if (t - c.inicio >= HORA) this.contagens.delete(k);
  }

  get tamanho(): number {
    return this.contagens.size;
  }
}
