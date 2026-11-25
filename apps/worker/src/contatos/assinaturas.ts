import { telefoneCanonico } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { inArray, sql } from "drizzle-orm";

/**
 * Caixa única, vínculo automático (0068): o telefone que a IA leu na assinatura do
 * e-mail (conferido no texto, 0044) entra na agenda da empresa junto com o e-mail
 * do remetente. Só acrescenta: e-mail ou telefone que já é de outro contato não muda
 * de dono; os dois já de contatos diferentes ficam como estão.
 * Conservador de propósito: só celular brasileiro (o fixo costuma ser a central da
 * empresa), só telefone que aparece numa assinatura só, e o e-mail nunca entra num
 * contato só porque o telefone bate (o telefone é o dado menos certo da assinatura).
 */
const CELULAR = /^55[1-9][1-9]9\d{8}$/;
export async function vincularPelasAssinaturas(db: Db): Promise<{ criados: number; acrescentados: number; ignorados: number }> {
  const r = { criados: 0, acrescentados: 0, ignorados: 0 };
  const linhas = (
    await db.execute<{ address: string; nome: string | null; cargo: string | null; empresa: string | null; telefone: string }>(sql`
      SELECT address, nome, cargo, empresa, telefone FROM email_signature_extractions
       WHERE status = 'ok' AND telefone IS NOT NULL`)
  ).rows;
  if (!linhas.length) return r;
  const comTelefone = linhas.map((l) => ({ ...l, tel: telefoneCanonico(l.telefone) })).filter((l): l is typeof l & { tel: string } => Boolean(l.tel && CELULAR.test(l.tel)));
  const vezes = new Map<string, number>();
  for (const l of comTelefone) vezes.set(l.tel, (vezes.get(l.tel) ?? 0) + 1);
  const pares = comTelefone.filter((l) => vezes.get(l.tel) === 1);
  r.ignorados += comTelefone.length - pares.length;
  const valores = [...new Set(pares.flatMap((p) => [p.address, p.tel]))];
  const existentes = new Map(
    (
      await db
        .select({ value: schema.contactIdentities.value, contactId: schema.contactIdentities.contactId })
        .from(schema.contactIdentities)
        .where(inArray(schema.contactIdentities.value, valores))
    ).map((x) => [x.value, x.contactId]),
  );
  for (const p of pares) {
    const doEmail = existentes.get(p.address);
    const doTelefone = existentes.get(p.tel);
    if (doEmail && doTelefone) {
      r.ignorados += doEmail === doTelefone ? 0 : 1;
      continue;
    }
    if (doTelefone) {
      r.ignorados += 1;
      continue;
    }
    if (doEmail) {
      await db.insert(schema.contactIdentities).values({ contactId: doEmail, kind: "telefone", value: p.tel, source: "assinatura" }).onConflictDoNothing();
      existentes.set(p.tel, doEmail);
      r.acrescentados += 1;
      continue;
    }
    const [c] = await db
      .insert(schema.contacts)
      .values({ name: (p.nome?.trim() || p.address).slice(0, 160), company: p.empresa?.slice(0, 160) ?? null, role: p.cargo?.slice(0, 120) ?? null })
      .returning({ id: schema.contacts.id });
    await db
      .insert(schema.contactIdentities)
      .values([
        { contactId: c!.id, kind: "email", value: p.address, source: "assinatura" },
        { contactId: c!.id, kind: "telefone", value: p.tel, source: "assinatura" },
      ])
      .onConflictDoNothing();
    existentes.set(p.address, c!.id);
    existentes.set(p.tel, c!.id);
    r.criados += 1;
  }
  return r;
}
