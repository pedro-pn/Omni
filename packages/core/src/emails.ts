/**
 * Vínculo de e-mails com missões (Fase 4, INSTRUCOES §6.9): pelo número da
 * missão, pelos códigos citados (proposta, NF) ou pelo domínio do cliente,
 * sempre com o motivo para a tela mostrar. Regras puras e testadas; o worker
 * só aplica.
 */

export type MotivoVinculo = "numero" | "proposta" | "nf" | "dominio";
export type VinculoEmail = { missionId: string; motivo: MotivoVinculo; detalhe: string };

export type MissaoVinculavel = {
  id: string;
  /** Código da missão (número do Prisma, 4 dígitos no filtroAPP). */
  code: string;
  /** Códigos de proposta (filtroAPP e oportunidades do Prisma). */
  propostas: string[];
  /** Números das NFs da missão. */
  notas: string[];
  /** Domínios de e-mail do cliente (Prisma). */
  dominios: string[];
  /** Só missões ativas entram no vínculo por domínio. */
  ativa: boolean;
};

export type EmailParaVinculo = { assunto: string; texto: string; enderecos: string[] };

/** Domínios que não identificam cliente (a própria empresa e e-mails pessoais). */
export const DOMINIOS_IGNORADOS = new Set([
  "filtrovali.com.br",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "outlook.com.br",
  "live.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
]);

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Números de missão citados: "Missão 5851", "missao nº 5851", "[5851]" ou o assunto começando por "5851 - ". */
function numerosCitados(texto: string, assunto: boolean): string[] {
  const achados = new Set<string>();
  for (const m of texto.matchAll(/\bmiss(?:ão|ao|ões|oes)\b\s*(?:n[º°o]?\.?\s*|#\s*)?(\d{4})\b/giu)) achados.add(m[1]!);
  for (const m of texto.matchAll(/\[(\d{4})\]/g)) achados.add(m[1]!);
  if (assunto) {
    const inicio = texto.match(/^\s*(?:(?:re|res|enc|fw|fwd|rv|tr)\s*:\s*)*(\d{4})\s*[-–—:]/iu);
    if (inicio) achados.add(inicio[1]!);
  }
  return [...achados];
}

function citaProposta(texto: string, codigo: string): boolean {
  const c = codigo.trim();
  if (c.length < 3) return false;
  // Código com barra ou letras (ex.: 090001/2026) é específico o bastante sozinho.
  if (/[^\d]/.test(c)) return new RegExp(`(^|[^\\w/])${escapar(c)}($|[^\\w/])`, "iu").test(texto);
  return new RegExp(`\\bproposta\\b[^\\d\\n]{0,30}0*${escapar(c.replace(/^0+/, ""))}\\b`, "iu").test(texto);
}

function citaNota(texto: string, numero: string): boolean {
  const n = numero.trim().replace(/^0+/, "");
  if (n.length < 3 || !/^\d+$/.test(n)) return false;
  return new RegExp(`\\b(?:nfs?-?e|nf|nota fiscal|nota)\\b[^\\d\\n]{0,15}0*${n}\\b`, "iu").test(texto);
}

const dominio = (endereco: string) => endereco.trim().toLowerCase().split("@")[1] ?? "";

export function vincularEmail(email: EmailParaVinculo, missoes: MissaoVinculavel[]): VinculoEmail[] {
  const vinculos = new Map<string, VinculoEmail>();
  const add = (v: VinculoEmail) => {
    const chave = `${v.missionId}|${v.motivo}`;
    if (!vinculos.has(chave)) vinculos.set(chave, v);
  };
  const porCodigo = new Map(missoes.map((m) => [m.code, m]));

  for (const [onde, texto, assunto] of [
    ["no assunto", email.assunto, true],
    ["no texto", email.texto, false],
  ] as const) {
    for (const n of numerosCitados(texto, assunto)) {
      const m = porCodigo.get(n);
      if (m) add({ missionId: m.id, motivo: "numero", detalhe: `Missão ${n} ${onde}` });
    }
  }

  const tudo = `${email.assunto}\n${email.texto}`;
  for (const m of missoes) {
    const p = m.propostas.find((c) => citaProposta(tudo, c));
    if (p) add({ missionId: m.id, motivo: "proposta", detalhe: `Proposta ${p} citada` });
    const nf = m.notas.find((n) => citaNota(tudo, n));
    if (nf) add({ missionId: m.id, motivo: "nf", detalhe: `NF ${nf.replace(/^0+/, "")} citada` });
  }

  // Domínio do cliente: só quando aponta para uma única missão ativa (senão é o cliente, não a missão).
  const dominios = new Set(email.enderecos.map(dominio).filter((d) => d && !DOMINIOS_IGNORADOS.has(d)));
  for (const d of dominios) {
    const candidatas = missoes.filter((m) => m.ativa && m.dominios.some((x) => x.toLowerCase() === d));
    if (candidatas.length === 1) add({ missionId: candidatas[0]!.id, motivo: "dominio", detalhe: `Domínio do cliente (${d})` });
  }
  return [...vinculos.values()];
}
