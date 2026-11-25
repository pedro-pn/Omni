/**
 * Agenda da empresa (caixa única): forma única de um telefone e de um nome, para
 * ligar o e-mail ao WhatsApp do mesmo contato sem depender de como foi escrito.
 */

/**
 * Telefone só com dígitos e DDI (Brasil por padrão). Celular brasileiro sem o 9
 * (como o WhatsApp ainda manda para números antigos: 55 47 9123-4567) ganha o 9,
 * para casar com o número como as pessoas escrevem. Null se não parecer telefone.
 */
export function telefoneCanonico(bruto: string | null | undefined): string | null {
  const texto = (bruto ?? "").trim();
  let d = texto.replace(/\D/g, "").replace(/^00/, "");
  if (!d) return null;
  // 0 + DDD (discagem nacional): tira o 0.
  if (!texto.startsWith("+") && /^0\d{10,11}$/.test(d)) d = d.slice(1);
  // DDD + número (10 ou 11 dígitos; DDD 55 também): Brasil.
  if (!texto.startsWith("+") && (d.length === 10 || d.length === 11)) d = `55${d}`;
  // Celular brasileiro sem o 9: 55 + DDD + 8 dígitos começando em 6–9.
  if (/^55[1-9][1-9][6-9]\d{7}$/.test(d)) d = `${d.slice(0, 4)}9${d.slice(4)}`;
  // Com "+", vale qualquer país (E.164: até 15 dígitos; EUA têm 11).
  return (texto.startsWith("+") ? /^[1-9]\d{10,14}$/ : /^\d{12,15}$/).test(d) ? d : null;
}

/** Nome para comparar: sem acento, minúsculo, espaços únicos; só nomes com 2 palavras ou mais. */
export function nomeParaComparar(nome: string | null | undefined): string | null {
  const n = (nome ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n.split(" ").filter((p) => p.length >= 2).length >= 2 ? n : null;
}

/** DDDs brasileiros válidos (Anatel). */
const DDDS = new Set(
  "11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99".split(" "),
);

/**
 * Telefones brasileiros escritos num texto, na forma da agenda (55 + DDD + número, com o 9
 * do celular). Só o que tem cara de telefone: DDD válido e escrito com parênteses, "+55"
 * ou separadores entre as partes — números corridos (protocolo, nota, CNPJ) não contam.
 */
export function telefonesNoTexto(texto: string): string[] {
  const achados = new Set<string>();
  const re = /(?<![\d\w/.])(\+?\s?55[\s.-]?)?(\(\s?0?(\d{2})\s?\)|0?(\d{2}))([\s.-]?)(9?\d{4})([\s.-]?)(\d{4})(?![\d\w/])/g;
  for (const m of texto.matchAll(re)) {
    const [, ddi, , dddParenteses, dddSolto, sep1, meio, sep2, fim] = m;
    const ddd = dddParenteses ?? dddSolto ?? "";
    if (!DDDS.has(ddd)) continue;
    const formatado = Boolean(ddi) || Boolean(dddParenteses) || Boolean(sep1) || Boolean(sep2);
    if (!formatado) continue;
    const tel = telefoneCanonico(`${ddd}${meio}${fim}`);
    if (tel) achados.add(tel);
  }
  return [...achados];
}

/** Celular brasileiro (55 + DDD + 9 + 8 dígitos). */
export const ehCelular = (t: string) => /^55[1-9][1-9]9\d{8}$/.test(t);

