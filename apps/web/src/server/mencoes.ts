import { schema, type Db } from "@omni/db";
import { and, eq, inArray } from "drizzle-orm";

import { nomeDaMencao, type Agenda, type Mencao } from "../lib/nomes-whatsapp.ts";
import { getPonteDeAcoes } from "./whatsapp.ts";

/**
 * Marcações nos grupos: o texto traz "@<id>", muitas vezes o @lid (um número que não é o
 * telefone). O telefone vem do que o Omni já sabe (agenda, conversas) e, para o resto, do
 * mapeamento que a sessão do número guarda (ponte de ações) — com cache, e sem atrasar a tela
 * quando a ponte não responde.
 */

const CACHE = new Map<string, { tel: string | null; ate: number }>();
const DIA = 24 * 3600_000;
let ponteFalhouAte = 0;
const digitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

async function telefonesDosLids(db: Db, numero: { id: string; phone: string | null }, lids: string[]): Promise<{ mapa: Map<string, string | null>; eu: string | null }> {
  const mapa = new Map<string, string | null>();
  let eu: string | null = (CACHE.get(`${numero.id}|eu`)?.tel ?? null) || null;
  if (!lids.length) return { mapa, eu };
  const [contatos, conversas] = await Promise.all([
    db
      .select({ lid: schema.whatsappContacts.lid, phone: schema.whatsappContacts.phone, jid: schema.whatsappContacts.jid })
      .from(schema.whatsappContacts)
      .where(and(eq(schema.whatsappContacts.numberId, numero.id), inArray(schema.whatsappContacts.lid, lids))),
    db
      .select({ lid: schema.whatsappChats.lid, phone: schema.whatsappChats.phone, jid: schema.whatsappChats.jid })
      .from(schema.whatsappChats)
      .where(and(eq(schema.whatsappChats.numberId, numero.id), eq(schema.whatsappChats.isGroup, false), inArray(schema.whatsappChats.lid, lids))),
  ]);
  for (const x of [...contatos, ...conversas]) {
    const tel = digitos(x.phone) || (x.jid.endsWith("@s.whatsapp.net") ? digitos(x.jid.split("@")[0]) : "");
    if (x.lid && /^\d{8,15}$/.test(tel)) mapa.set(x.lid, tel);
  }
  const agora = Date.now();
  const faltam: string[] = [];
  for (const lid of lids) {
    if (mapa.has(lid)) continue;
    const c = CACHE.get(`${numero.id}|${lid}`);
    if (c && c.ate > agora) mapa.set(lid, c.tel);
    else faltam.push(lid);
  }
  const ponte = getPonteDeAcoes();
  if ((faltam.length || !CACHE.has(`${numero.id}|eu`)) && ponte && numero.phone && ponteFalhouAte < agora) {
    try {
      const r = await ponte.lids(numero.phone, faltam);
      for (const lid of faltam) {
        const tel = r.mapa[lid] ?? null;
        mapa.set(lid, tel);
        CACHE.set(`${numero.id}|${lid}`, { tel, ate: agora + (tel ? DIA : 10 * 60_000) });
      }
      eu = r.eu;
      CACHE.set(`${numero.id}|eu`, { tel: r.eu ?? "", ate: agora + DIA });
    } catch {
      ponteFalhouAte = agora + 60_000;
    }
    if (CACHE.size > 20_000) CACHE.clear();
  }
  return { mapa, eu };
}

/** As marcações de cada mensagem (pelo id da mensagem no Omni), com o nome a mostrar. */
export async function mencoesDasMensagens(
  db: Db,
  conversa: { numberId: string },
  linhas: Array<{ id: string; mentions: string[]; authorJid: string | null; authorName: string | null }>,
  agenda: Agenda | null,
): Promise<Map<string, Mencao[]>> {
  const r = new Map<string, Mencao[]>();
  const jids = [...new Set(linhas.flatMap((x) => x.mentions))];
  if (!jids.length) return r;
  const [numero] = await db.select({ id: schema.whatsappNumbers.id, phone: schema.whatsappNumbers.phone }).from(schema.whatsappNumbers).where(eq(schema.whatsappNumbers.id, conversa.numberId));
  if (!numero) return r;
  const { mapa, eu } = await telefonesDosLids(
    db,
    numero,
    jids.filter((j) => j.endsWith("@lid")),
  );
  const telefoneDe = (jid: string) => (jid.endsWith("@lid") ? (mapa.get(jid) ?? null) : digitos(jid.split("@")[0]) || null);
  const telefones = [...new Set(jids.map(telefoneDe).filter((t): t is string => Boolean(t)))];
  const conversas = telefones.length
    ? await db
        .select({ phone: schema.whatsappChats.phone, name: schema.whatsappChats.name, manual: schema.whatsappChats.nameManual })
        .from(schema.whatsappChats)
        .where(and(eq(schema.whatsappChats.numberId, conversa.numberId), eq(schema.whatsappChats.isGroup, false), inArray(schema.whatsappChats.phone, telefones)))
    : [];
  const nomes = new Map(conversas.map((c) => [c.phone, c]));
  // Nome de perfil de quem já escreveu nesta conversa.
  const perfis = new Map<string, string>();
  for (const x of linhas) if (x.authorJid && x.authorName) perfis.set(digitos(x.authorJid.split("@")[0]), x.authorName);
  const meu = digitos(numero.phone);
  const porJid = new Map<string, Mencao | null>();
  for (const jid of jids) {
    const telefone = telefoneDe(jid);
    const c = telefone ? nomes.get(telefone) : undefined;
    porJid.set(
      jid,
      nomeDaMencao(
        { jid, telefone, eu: jid === eu || (Boolean(meu) && telefone === meu), nomeDaConversa: c?.name ?? null, nomeManual: c?.manual ?? false, perfil: telefone ? (perfis.get(telefone) ?? null) : null },
        agenda,
      ),
    );
  }
  for (const x of linhas) {
    const ms = x.mentions.flatMap((j) => {
      const m = porJid.get(j);
      return m ? [m] : [];
    });
    if (ms.length) r.set(x.id, ms);
  }
  return r;
}
