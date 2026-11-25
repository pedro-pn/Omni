import { DOMINIOS_IGNORADOS } from "./emails.ts";

/**
 * Participantes da missão (INSTRUCOES §6.7, `scanMail`/`scanWa`/`upsertPart` do
 * protótipo): quem aparece nos e-mails da missão (remetente, destinatário, cópia)
 * e quem escreve nos grupos do WhatsApp ligados a ela. Cliente × Filtrovali ×
 * terceiros pelo domínio; e-mails de setor marcados; endereços automáticos fora.
 * O cargo pela assinatura fica para depois (o corpo dos e-mails não é guardado);
 * nome, cargo e empresa podem ser completados à mão.
 */

export type OrigemParticipante = "remetente" | "destinatario" | "copia" | "whatsapp";
export type LadoParticipante = "cliente" | "filtrovali" | "terceiro" | "a_definir";

export type ParticipanteDetectado = {
  /** `email:<endereço>` ou `wa:<jid>` */
  chave: string;
  nome: string | null;
  email: string | null;
  telefone: string | null;
  lado: LadoParticipante;
  setor: boolean;
  origens: OrigemParticipante[];
  vezes: number;
  ultimaVez: string;
};

export type EntradaParticipantes = {
  emails: Array<{ de: { nome: string | null; endereco: string | null }; para: Array<{ nome?: string | null; endereco: string }>; cc: Array<{ nome?: string | null; endereco: string }>; em: string }>;
  /** Uma linha por mensagem, ou já agregada (`vezes`). */
  whatsapp: Array<{ jid: string | null; nome: string | null; em: string; vezes?: number }>;
  dominiosCliente: string[];
  /** Telefones (só dígitos) de colaboradores da Filtrovali. */
  telefonesFiltrovali?: string[];
};

const DOMINIO_FILTROVALI = "filtrovali.com.br";
const SETORES = /^(compras?|financeiro|contato|comercial|vendas|suprimentos?|fiscal|nfe|nf-?e|faturamento|rh|recepcao|atendimento|sac|qualidade|engenharia|manutencao|almoxarifado|logistica|ti|suporte|juridico|contabilidade|adm|administrativo|projetos|planejamento|orcamentos?|cotacao|cotacoes|expedicao|portaria|seguranca|sesmt|medicao|medicoes|contratos?)([._-].*)?$/;
const AUTOMATICOS = /^(no-?reply|nao-?responda|naoresponda|donotreply|do-not-reply|mailer-daemon|postmaster|notifica(coes|cao|tions?)|bounce|alertas?)([._+-].*)?@/;

const limpar = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function ladoDoEmail(endereco: string, dominiosCliente: string[]): LadoParticipante {
  const d = endereco.split("@")[1]?.toLowerCase() ?? "";
  if (d === DOMINIO_FILTROVALI || d.endsWith(`.${DOMINIO_FILTROVALI}`)) return "filtrovali";
  if (dominiosCliente.some((x) => x.toLowerCase() === d)) return "cliente";
  // Webmail (gmail, hotmail…) não diz de que empresa a pessoa é.
  if (DOMINIOS_IGNORADOS.has(d)) return "a_definir";
  return "terceiro";
}

export const ehEmailDeSetor = (endereco: string) => SETORES.test(semAcento(endereco.split("@")[0] ?? ""));
export const ehEnderecoAutomatico = (endereco: string) => AUTOMATICOS.test(semAcento(endereco));

export function detectarParticipantes(e: EntradaParticipantes): ParticipanteDetectado[] {
  type Acumulado = ParticipanteDetectado & { nomes: Map<string, number> };
  const mapa = new Map<string, Acumulado>();
  const somar = (chave: string, base: Omit<ParticipanteDetectado, "chave" | "nome" | "origens" | "vezes" | "ultimaVez">, nome: string | null, origem: OrigemParticipante, em: string, vezes = 1) => {
    let p = mapa.get(chave);
    if (!p) mapa.set(chave, (p = { chave, nome: null, origens: [], vezes: 0, ultimaVez: em, nomes: new Map(), ...base }));
    p.vezes += vezes;
    if (em > p.ultimaVez) p.ultimaVez = em;
    if (!p.origens.includes(origem)) p.origens.push(origem);
    const n = limpar(nome);
    if (n && !n.includes("@") && !/^\+?\d[\d\s-]+$/.test(n)) p.nomes.set(n, (p.nomes.get(n) ?? 0) + vezes);
  };
  const porEmail = (endereco: string | null | undefined, nome: string | null | undefined, origem: OrigemParticipante, em: string) => {
    const a = limpar(endereco).toLowerCase();
    if (!a.includes("@") || ehEnderecoAutomatico(a)) return;
    somar(`email:${a}`, { email: a, telefone: null, lado: ladoDoEmail(a, e.dominiosCliente), setor: ehEmailDeSetor(a) }, nome ?? null, origem, em);
  };
  for (const m of e.emails) {
    porEmail(m.de.endereco, m.de.nome, "remetente", m.em);
    for (const r of m.para) porEmail(r.endereco, r.nome, "destinatario", m.em);
    for (const r of m.cc) porEmail(r.endereco, r.nome, "copia", m.em);
  }
  const daFiltrovali = new Set((e.telefonesFiltrovali ?? []).map((t) => t.replace(/\D/g, "")).filter(Boolean));
  for (const w of e.whatsapp) {
    if (!w.jid) continue;
    const tel = w.jid.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null;
    const lado: LadoParticipante = tel && [...daFiltrovali].some((f) => f.endsWith(tel.slice(-8))) ? "filtrovali" : "a_definir";
    somar(`wa:${w.jid}`, { email: null, telefone: tel, lado, setor: false }, w.nome, "whatsapp", w.em, w.vezes ?? 1);
  }
  return [...mapa.values()]
    .map(({ nomes, ...p }) => ({ ...p, nome: [...nomes.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ?? null }))
    .sort((a, b) => b.vezes - a.vezes || b.ultimaVez.localeCompare(a.ultimaVez));
}
