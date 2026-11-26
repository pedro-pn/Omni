import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Ações nas mensagens do WhatsApp (0087): o que o webhook grava e quem vê e muda cada coisa (RLS). */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
};
async function disponivel(): Promise<boolean> {
  const client = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();

async function falha(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => null,
    (e: Error & { cause?: Error }) => e,
  );
  expect(error, "deveria ter falhado").not.toBeNull();
  expect(String(error!.cause?.message ?? error!.message)).toMatch(pattern);
}

describe.skipIf(!available)("ações nas mensagens do WhatsApp", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 6);
  const instancia = `omni-acoes${tag}`;
  const GRUPO = `120363${Date.now().toString().slice(-9)}@g.us`;
  let dono = "";
  let outro = "";
  let chat = "";

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 3);
    const pessoa = async (nome: string) => {
      const id = (await owner.query("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@acoes.invalid`, nome])).rows[0].id as string;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao')", [id]);
      return id;
    };
    dono = await pessoa("dono");
    outro = await pessoa("outro");
    const numero = (await owner.query("INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, phone, status) VALUES ($1, 'Meu', 'outro', $2, '5547900000001', 'conectado') RETURNING id", [instancia, dono])).rows[0].id;
    chat = (await owner.query("INSERT INTO whatsapp_chats (number_id, jid, is_group, name) VALUES ($1, $2, true, 'Grupo') RETURNING id", [numero, GRUPO])).rows[0].id;
    for (const [w, de, texto] of [["M1", false, "Bom dia"], ["M2", true, "Oi"], ["M3", false, "Tchau"], ["M4", false, "Mais uma"]] as const) {
      await owner.query("INSERT INTO whatsapp_messages (chat_id, wa_id, from_me, author_jid, kind, body, sent_at) VALUES ($1, $2, $3, '5547900000011@s.whatsapp.net', 'texto', $4, now())", [chat, w, de, texto]);
    }
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM whatsapp_numbers WHERE instance_name = $1", [instancia]).catch(() => undefined);
      await owner.query("UPDATE people SET active = false WHERE email LIKE $1", [`%-${tag}@acoes.invalid`]);
    }
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("webhook: mensagem citada e encaminhada, reação (e tirar), editada, apagada (some o conteúdo) e fixada (até 3)", async () => {
    await app.query("SELECT app.whatsapp_registrar_mensagem($1, $2, NULL, true, NULL, 'M5', false, '5547900000012@s.whatsapp.net', 'Caio', 'texto', 'Pode', NULL, now(), 'M1', 'Bom dia', '5547900000011@s.whatsapp.net', true)", [instancia, GRUPO]);
    expect((await owner.query("SELECT quoted_wa_id, quoted_body, forwarded FROM whatsapp_messages WHERE chat_id = $1 AND wa_id = 'M5'", [chat])).rows[0]).toEqual({ quoted_wa_id: "M1", quoted_body: "Bom dia", forwarded: true });
    await app.query("SELECT app.whatsapp_registrar_reacao($1, $2, NULL, 'M1', false, '5547900000012@s.whatsapp.net', 'Caio', '👍', now())", [instancia, GRUPO]);
    await app.query("SELECT app.whatsapp_registrar_reacao($1, $2, NULL, 'M1', true, NULL, NULL, '❤️', now())", [instancia, GRUPO]);
    expect((await owner.query("SELECT reactor, emoji FROM whatsapp_reactions WHERE chat_id = $1 ORDER BY reactor", [chat])).rows).toEqual([
      { reactor: "5547900000012@s.whatsapp.net", emoji: "👍" },
      { reactor: "eu", emoji: "❤️" },
    ]);
    await app.query("SELECT app.whatsapp_registrar_reacao($1, $2, NULL, 'M1', true, NULL, NULL, '', now())", [instancia, GRUPO]);
    expect((await owner.query("SELECT count(*)::int AS n FROM whatsapp_reactions WHERE chat_id = $1", [chat])).rows[0].n).toBe(1);
    await app.query("SELECT app.whatsapp_registrar_edicao($1, $2, NULL, 'M2', 'Oi, tudo bem?', now())", [instancia, GRUPO]);
    await app.query("SELECT app.whatsapp_registrar_apagada($1, $2, NULL, 'M1')", [instancia, GRUPO]);
    const m = (await owner.query("SELECT wa_id, body, edited_at IS NOT NULL AS editada, deleted_at IS NOT NULL AS apagada FROM whatsapp_messages WHERE chat_id = $1 AND wa_id IN ('M1','M2') ORDER BY wa_id", [chat])).rows;
    expect(m).toEqual([
      { wa_id: "M1", body: null, editada: false, apagada: true },
      { wa_id: "M2", body: "Oi, tudo bem?", editada: true, apagada: false },
    ]);
    expect((await owner.query("SELECT count(*)::int AS n FROM whatsapp_reactions WHERE chat_id = $1 AND wa_id = 'M1'", [chat])).rows[0].n).toBe(0); // reação da apagada sai
    for (const w of ["M2", "M3", "M4", "M5"]) await app.query("SELECT app.whatsapp_registrar_fixada($1, $2, NULL, $3, true)", [instancia, GRUPO, w]);
    expect((await owner.query("SELECT wa_id FROM whatsapp_pinned_messages WHERE chat_id = $1 ORDER BY wa_id", [chat])).rows.map((x) => x.wa_id)).toEqual(["M3", "M4", "M5"]);
    await app.query("SELECT app.whatsapp_registrar_fixada($1, $2, NULL, 'M5', false)", [instancia, GRUPO]);
    // Conversa de outro número: nada acontece (não cria conversa).
    await app.query("SELECT app.whatsapp_registrar_reacao('omni-naoexiste1', $1, NULL, 'M1', false, NULL, NULL, '👍', now())", [GRUPO]);
  });

  it("marcações (0089): guarda os JIDs de pessoa, sem repetir; o resto fica de fora", async () => {
    await app.query(
      "SELECT app.whatsapp_registrar_mensagem($1, $2, NULL, true, NULL, 'M9', false, '5547900000012@s.whatsapp.net', 'Caio', 'texto', '@222222222222222 olha', NULL, now(), NULL, NULL, NULL, false, $3)",
      [instancia, GRUPO, ["222222222222222@lid", "5547900000011@s.whatsapp.net", "222222222222222@lid", "120363000000000001@g.us", "x"]],
    );
    const { rows } = await owner.query("SELECT mentions FROM whatsapp_messages WHERE chat_id = $1 AND wa_id = 'M9'", [chat]);
    expect([...rows[0].mentions].sort()).toEqual(["222222222222222@lid", "5547900000011@s.whatsapp.net"]);
    // Sem marcações (a chamada antiga, 17 parâmetros), a lista fica vazia.
    const { rows: m5 } = await owner.query("SELECT mentions FROM whatsapp_messages WHERE chat_id = $1 AND wa_id = 'M5'", [chat]);
    expect(m5[0].mentions).toEqual([]);
  });

  it("mensagem que o Omni não mostra (outro) não muda a ordem nem a prévia da conversa (0090)", async () => {
    const antes = (await owner.query("SELECT last_message_at, last_preview FROM whatsapp_chats WHERE id = $1", [chat])).rows[0];
    await app.query(
      "SELECT app.whatsapp_registrar_mensagem($1, $2, NULL, true, NULL, 'M-OUTRO', false, '5547900000012@s.whatsapp.net', 'Caio', 'outro', NULL, NULL, now() + interval '1 hour')",
      [instancia, GRUPO],
    );
    const depois = (await owner.query("SELECT last_message_at, last_preview FROM whatsapp_chats WHERE id = $1", [chat])).rows[0];
    expect(depois).toEqual(antes);
    expect((await owner.query("SELECT count(*)::int AS n FROM whatsapp_messages WHERE chat_id = $1 AND wa_id = 'M-OUTRO'", [chat])).rows[0].n).toBe(1);
  });

  it("RLS: quem vê a conversa vê reações e fixadas; só o dono fixa; favoritas, apagadas para mim e conversas fixadas são de cada um", async () => {
    await app.query("SELECT app.whatsapp_registrar_reacao($1, $2, NULL, 'M3', false, '5547900000012@s.whatsapp.net', 'Caio', '👍', now())", [instancia, GRUPO]);
    const ver = (quem: string, tabela: string) => withPerson(app, quem, (db) => db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${tabela} WHERE chat_id = '${chat}'`))).then((r) => r.rows[0]!.n);
    expect(await ver(dono, "whatsapp_reactions")).toBe(1);
    expect(await ver(outro, "whatsapp_reactions")).toBe(0);
    expect(await ver(outro, "whatsapp_pinned_messages")).toBe(0);
    // Ninguém grava reação direto (só pelas funções).
    await falha(withPerson(app, dono, (db) => db.execute(sql`INSERT INTO whatsapp_reactions (chat_id, wa_id, reactor, emoji) VALUES (${chat}::uuid, 'M3', 'eu', '👍')`)), /permission denied/);
    // Fixar mensagem: o dono sim, outra pessoa não.
    await withPerson(app, dono, (db) => db.execute(sql`INSERT INTO whatsapp_pinned_messages (chat_id, wa_id, pinned_by) VALUES (${chat}::uuid, 'M2', ${dono}::uuid)`));
    await falha(withPerson(app, outro, (db) => db.execute(sql`INSERT INTO whatsapp_pinned_messages (chat_id, wa_id, pinned_by) VALUES (${chat}::uuid, 'M3', ${outro}::uuid)`)), /row-level security/);
    // Favoritar e fixar conversa: só da própria pessoa e de conversa que ela vê.
    await withPerson(app, dono, (db) => db.execute(sql`INSERT INTO whatsapp_message_flags (person_id, chat_id, wa_id, starred) VALUES (${dono}::uuid, ${chat}::uuid, 'M3', true)`));
    await withPerson(app, dono, (db) => db.execute(sql`INSERT INTO whatsapp_chat_pins (person_id, chat_id) VALUES (${dono}::uuid, ${chat}::uuid)`));
    await falha(withPerson(app, outro, (db) => db.execute(sql`INSERT INTO whatsapp_message_flags (person_id, chat_id, wa_id, starred) VALUES (${outro}::uuid, ${chat}::uuid, 'M3', true)`)), /row-level security/);
    await falha(withPerson(app, outro, (db) => db.execute(sql`INSERT INTO whatsapp_chat_pins (person_id, chat_id) VALUES (${dono}::uuid, ${chat}::uuid)`)), /row-level security/);
    expect(await ver(outro, "whatsapp_message_flags")).toBe(0);
    expect(await ver(dono, "whatsapp_chat_pins")).toBe(1);
  });
});
