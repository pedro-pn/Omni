import { formatarTelefone } from "@omni/core";

/**
 * Nomes no WhatsApp do Omni como no WhatsApp Web (0088): quem está salvo na agenda do celular
 * aparece com o nome salvo; quem não está, pelo número — com o nome de perfil (o que a pessoa
 * escolheu no WhatsApp) discreto, "~ Nome". Nome dado no Omni (name_manual) vale como salvo.
 * Enquanto a agenda do número não foi lida, vale o nome de sempre.
 */

export type Agenda = Map<string, string>;

const digitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** Agenda de um número: o nome salvo pelo JID, pelo @lid e pelo telefone (só dígitos). */
export function montarAgenda(contatos: Array<{ jid: string; lid: string | null; phone: string | null; savedName: string }>): Agenda {
  const a: Agenda = new Map();
  for (const c of contatos) {
    a.set(c.jid, c.savedName);
    if (c.lid) a.set(c.lid, c.savedName);
    const tel = c.phone ?? (c.jid.endsWith("@s.whatsapp.net") ? digitos(c.jid.split("@")[0]) : "");
    if (tel) a.set(tel, c.savedName);
  }
  return a;
}

/** O nome salvo de alguém pela agenda (JID, @lid ou telefone). */
export function nomeSalvo(agenda: Agenda | null, ...chaves: Array<string | null | undefined>): string | null {
  if (!agenda) return null;
  for (const k of chaves) {
    if (!k) continue;
    const v = agenda.get(k) ?? agenda.get(digitos(k.split("@")[0]));
    if (v) return v;
  }
  return null;
}

export function nomeDaConversa(
  c: { grupo: boolean; nome: string | null; nomeManual: boolean; telefone: string | null; jid: string; lid: string | null },
  agenda: Agenda | null,
): { nome: string; perfil: string | null; salvo: boolean } {
  const telefone = formatarTelefone(c.telefone);
  if (c.grupo) return { nome: c.nome ?? "Grupo", perfil: null, salvo: false };
  if (c.nomeManual && c.nome) return { nome: c.nome, perfil: null, salvo: true };
  if (!agenda) return { nome: c.nome ?? telefone ?? "Contato", perfil: null, salvo: Boolean(c.nome) };
  const salvo = nomeSalvo(agenda, c.jid, c.lid, c.telefone);
  if (salvo) return { nome: salvo, perfil: null, salvo: true };
  // Não salvo: o número; sem número (só @lid), o nome de perfil mesmo.
  return telefone ? { nome: telefone, perfil: c.nome, salvo: false } : { nome: c.nome ? `~ ${c.nome}` : "Contato", perfil: null, salvo: false };
}

/** Quem escreveu no grupo: o nome salvo; senão o número (e o nome de perfil à parte). */
export function nomeDoAutor(autorJid: string | null, nomePerfil: string | null, agenda: Agenda | null): { autor: string | null; perfil: string | null } {
  const telefone = formatarTelefone(autorJid?.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null);
  if (!agenda) return { autor: nomePerfil ?? telefone, perfil: null };
  const salvo = nomeSalvo(agenda, autorJid);
  if (salvo) return { autor: salvo, perfil: null };
  return telefone ? { autor: telefone, perfil: nomePerfil } : { autor: nomePerfil ? `~ ${nomePerfil}` : null, perfil: null };
}

/** Uma marcação na mensagem: o "@<chave>" do texto, o nome a mostrar e o telefone (abre a conversa). */
export type Mencao = { chave: string; nome: string; telefone: string | null; eu: boolean };

/**
 * O nome de quem foi marcado, pela mesma regra dos autores: salvo na agenda → o nome salvo; não
 * salvo → o número ("~ perfil" sem número). Sem a agenda lida, o nome da conversa ou o de perfil.
 * Sem nada (um @lid que a sessão não conhece), null: o texto fica como veio.
 */
export function nomeDaMencao(
  m: { jid: string; telefone: string | null; eu: boolean; nomeDaConversa: string | null; nomeManual: boolean; perfil: string | null },
  agenda: Agenda | null,
): Mencao | null {
  const chave = m.jid.split("@")[0]!;
  if (m.eu) return { chave, nome: "Você", telefone: null, eu: true };
  const telefone = formatarTelefone(m.telefone);
  let nome: string | null;
  if (m.nomeManual && m.nomeDaConversa) nome = m.nomeDaConversa;
  else if (agenda) nome = nomeSalvo(agenda, m.jid, m.telefone) ?? telefone ?? (m.perfil ? `~ ${m.perfil}` : null);
  else nome = m.nomeDaConversa ?? m.perfil ?? telefone;
  return nome ? { chave, nome, telefone: m.telefone, eu: false } : null;
}
