import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** WhatsApp (migration 0027): quem cadastra, quem vê as conversas e o que o webhook grava. */

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

describe.skipIf(!available)("WhatsApp: permissões e webhook", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const instancia = `omni-t${tag}`;
  const p: Record<string, string> = {};
  let numero = "";

  async function pessoa(nome: string, perfil: string) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, nome]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }
  const como = (quem: string, q: ReturnType<typeof sql>) => withPerson(app, quem, (db) => db.execute<Record<string, unknown>>(q)).then((r) => r.rows);
  // O webhook chama sem pessoa na sessão.
  const webhook = (q: string, v: unknown[]) => app.query(q, v);
  const mensagem = (id: string, texto: string, extra: Partial<{ jid: string; deMim: boolean; nome: string }> = {}) =>
    webhook("SELECT app.whatsapp_registrar_mensagem($1, $2, NULL, false, '5547999990000', $3, $4, $2, $5, 'texto', $6, NULL, now()) AS nova", [
      instancia,
      extra.jid ?? "5547999990000@s.whatsapp.net",
      id,
      extra.deMim ?? false,
      extra.nome ?? "Cliente",
      texto,
    ]).then((r) => r.rows[0]!.nova as boolean);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    p.admin = await pessoa("admin", "admin");
    p.dono = await pessoa("dono", "operacao");
    p.membro = await pessoa("membro", "operacao");
    p.outro = await pessoa("outro", "gerente");
    p.diretoria = await pessoa("diretoria", "diretoria");
  });

  afterAll(async () => {
    await owner?.query("DELETE FROM whatsapp_numbers WHERE instance_name LIKE $1", [`omni-t${tag}%`]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("cada pessoa cria e administra o próprio número; a Administração não cria, não lê nem remove (0055–0056)", async () => {
    const direto = (quem: string, nome: string) =>
      como(quem, sql`INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, created_by) VALUES (${nome}, 'Operação', 'operacao', ${p.dono}::uuid, ${quem}::uuid) RETURNING id`);
    for (const quem of [p.admin!, p.outro!, p.diretoria!, p.dono!]) await expect(direto(quem, `omni-t${tag}x`)).rejects.toThrow();
    const meu = (quem: string, nome: string) => como(quem, sql`SELECT app.criar_meu_whatsapp(${nome}) AS id`).then((r) => String(r[0]!.id));
    numero = await meu(p.dono!, instancia);
    expect(await meu(p.dono!, `omni-t${tag}z`)).toBe(numero); // um número por vez: devolve o mesmo
    const [n] = (await owner.query("SELECT owner_person_id, label, purpose FROM whatsapp_numbers WHERE id = $1", [numero])).rows;
    expect(n).toEqual({ owner_person_id: p.dono, label: "WhatsApp de dono", purpose: "outro" });
    // Sem perfil no Omni, não cria.
    const semPerfil = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, 'Sem perfil') RETURNING id", [`semperfil-${tag}@filtrovali.com.br`])).rows[0]!.id;
    await expect(meu(semPerfil, `omni-t${tag}w`)).rejects.toThrow();
    // A Administração e os outros não veem o número nem alteram nada.
    const ver = sql`SELECT id FROM whatsapp_numbers WHERE id = ${numero}::uuid`;
    expect(await como(p.dono!, ver)).toHaveLength(1);
    for (const quem of [p.admin!, p.diretoria!, p.outro!]) expect(await como(quem, ver)).toEqual([]);
    expect(await como(p.admin!, sql`UPDATE whatsapp_numbers SET label = 'x' WHERE id = ${numero}::uuid RETURNING id`)).toEqual([]);
    const remover = (quem: string) => como(quem, sql`SELECT app.whatsapp_remover_numero(${numero}::uuid) AS ok`).then((r) => r[0]!.ok);
    expect(await remover(p.admin!)).toBe(false);
    expect(await remover(p.outro!)).toBe(false);
    // Histórico: só o dono pede.
    await expect(como(p.admin!, sql`INSERT INTO whatsapp_history_imports (number_id, group_jids, requested_by) VALUES (${numero}::uuid, ARRAY['120363000000000001@g.us'], ${p.admin}::uuid)`)).rejects.toThrow();
    await como(p.dono!, sql`INSERT INTO whatsapp_history_imports (number_id, group_jids, requested_by) VALUES (${numero}::uuid, ARRAY['120363000000000001@g.us'], ${p.dono}::uuid)`);
    expect(await como(p.admin!, sql`SELECT id FROM whatsapp_history_imports WHERE number_id = ${numero}::uuid`)).toEqual([]);
    await owner.query("DELETE FROM whatsapp_history_imports WHERE number_id = $1", [numero]);
    // Ninguém inclui outras pessoas no número (0054).
    await expect(como(p.admin!, sql`INSERT INTO whatsapp_number_members (number_id, person_id, added_by) VALUES (${numero}::uuid, ${p.membro}::uuid, ${p.admin}::uuid)`)).rejects.toThrow();
  });

  it("o webhook grava uma vez só; status só avança; conexão atualiza o número", async () => {
    expect(await mensagem("W1", "Bom dia")).toBe(true);
    expect(await mensagem("W1", "Bom dia")).toBe(false); // reentrega do webhook
    expect(await mensagem("W2", "Chegamos 8h.", { deMim: true })).toBe(true);
    // Instância desconhecida: ignora.
    expect((await webhook("SELECT app.whatsapp_registrar_mensagem('omni-naoexiste1', '5547999990000@s.whatsapp.net', NULL, false, NULL, 'Z', false, NULL, NULL, 'texto', 'x', NULL, now()) AS nova", [])).rows[0]!.nova).toBe(false);

    await webhook("SELECT app.whatsapp_registrar_status($1, '5547999990000@s.whatsapp.net', 'W2', 'lida')", [instancia]);
    await webhook("SELECT app.whatsapp_registrar_status($1, '5547999990000@s.whatsapp.net', 'W2', 'entregue')", [instancia]);
    const { rows } = await owner.query("SELECT m.wa_id, m.status, c.name, c.last_preview FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id WHERE c.number_id = $1 ORDER BY m.wa_id", [numero]);
    expect(rows).toEqual([
      { wa_id: "W1", status: null, name: "Cliente", last_preview: "Chegamos 8h." },
      { wa_id: "W2", status: "lida", name: "Cliente", last_preview: "Chegamos 8h." },
    ]);

    await webhook("SELECT app.whatsapp_registrar_conexao($1, 'conectado', '5547988880000', 'Operação')", [instancia]);
    const [n] = (await owner.query("SELECT status, phone, profile_name FROM whatsapp_numbers WHERE id = $1", [numero])).rows;
    expect(n).toEqual({ status: "conectado", phone: "5547988880000", profile_name: "Operação" });
  });

  it("conversas: só o responsável vê (0054); nem diretoria, nem Administração, nem outros; ninguém grava direto", async () => {
    const conversas = sql`SELECT c.jid, (SELECT count(*)::int FROM whatsapp_messages m WHERE m.chat_id = c.id) AS n FROM whatsapp_chats c WHERE c.number_id = ${numero}::uuid`;
    expect(await como(p.dono!, conversas)).toEqual([{ jid: "5547999990000@s.whatsapp.net", n: 2 }]);
    for (const quem of [p.membro!, p.diretoria!, p.outro!]) expect(await como(quem, conversas)).toEqual([]);
    // Avisos no celular das mensagens recebidas: também só o responsável.
    const avisos = await owner.query("SELECT * FROM app.destinatarios_whatsapp((SELECT id FROM whatsapp_chats WHERE number_id = $1 LIMIT 1))", [numero]);
    expect(avisos.rows.map((r) => Object.values(r)[0])).toEqual([p.dono]);
    expect(await como(p.admin!, conversas)).toEqual([]); // administrar não é ler as conversas
    await expect(
      como(p.dono!, sql`INSERT INTO whatsapp_messages (chat_id, wa_id, from_me, kind, sent_at) SELECT id, 'F', true, 'texto', now() FROM whatsapp_chats WHERE number_id = ${numero}::uuid`),
    ).rejects.toThrow();
  });

  it("mesma pessoa pelo @lid e pelo número: uma conversa só (0048); nome e foto pela lista da Evolution", async () => {
    const lid = `9${tag.replace(/\D/g, "1").padEnd(11, "1").slice(0, 11)}@lid`;
    const jid = "5547933330000@s.whatsapp.net";
    const reg = (chat: string, l: string | null, tel: string | null, id: string) =>
      webhook("SELECT app.whatsapp_registrar_mensagem($1, $2, $3, false, $4, $5, false, $2, 'Rogério', 'texto', 'oi', NULL, now())", [instancia, chat, l, tel, id]);
    await reg(lid, lid, null, "LID1"); // primeiro só o @lid: conversa provisória
    await reg(jid, lid, "5547933330000", "LID2"); // depois com o número: junta na conversa do número
    await reg(lid, lid, null, "LID3"); // de novo só o @lid: vai para a conversa do número
    await reg(jid, lid, "5547933330000", "LID2"); // reentrega
    await webhook("SELECT app.whatsapp_registrar_status($1, $2, 'LID2', 'lida')", [instancia, lid]);
    const conversas = (await owner.query("SELECT id, jid, lid, phone FROM whatsapp_chats WHERE number_id = $1 AND (jid IN ($2, $3) OR lid = $2)", [numero, lid, jid])).rows;
    expect(conversas.map(({ jid: j, lid: l, phone }) => ({ j, l, phone }))).toEqual([{ j: jid, l: lid, phone: "5547933330000" }]);
    const msgs = (await owner.query("SELECT wa_id, status FROM whatsapp_messages WHERE chat_id = $1 ORDER BY wa_id", [conversas[0]!.id])).rows;
    expect(msgs).toEqual([{ wa_id: "LID1", status: null }, { wa_id: "LID2", status: "lida" }, { wa_id: "LID3", status: null }]);

    // Perfil: foto só de endereço do WhatsApp; nome da lista de conversas só se faltar; entrada sem foto não apaga a foto.
    const perfil = (j: string, nome: string | null, foto: string | null, agenda = false, tel: string | null = null) =>
      owner.query("SELECT app.whatsapp_perfil_conversa($1, $2, $3, $4, $5, $6) AS mudou", [numero, j, nome, foto, agenda, tel]).then((r) => r.rows[0]!.mudou);
    const nomeEFoto = () => owner.query("SELECT name, photo_url FROM whatsapp_chats WHERE id = $1", [conversas[0]!.id]).then((r) => r.rows[0]);
    expect(await perfil(lid, "Rogério | Gerente", "https://pps.whatsapp.net/v/foto.jpg?oe=1")).toBe(true);
    expect(await perfil(jid, null, null)).toBe(false);
    expect(await perfil(jid, null, "https://exemplo.com/foto.jpg")).toBe(false);
    expect(await nomeEFoto()).toEqual({ name: "Rogério", photo_url: "https://pps.whatsapp.net/v/foto.jpg?oe=1" });
    // 0069: o nome da agenda do celular vale sempre (como no WhatsApp Web); número no lugar de nome, nunca.
    expect(await perfil(jid, "Rogério da Agenda", null, true)).toBe(true);
    expect(await perfil(jid, "+55 47 93333-0000", null, true)).toBe(false);
    expect((await nomeEFoto()).name).toBe("Rogério da Agenda");
    await expect(app.query("SELECT app.whatsapp_perfil_conversa($1, $2, 'x', NULL, true, NULL)", [numero, jid])).rejects.toThrow(/permission/);
  });

  it("conversa só pelo @lid ganha o número e o nome da agenda; com a conversa do número, junta; número não vira nome (0069)", async () => {
    const instancia = (await owner.query<{ instance_name: string }>("SELECT instance_name FROM whatsapp_numbers WHERE id = $1", [numero])).rows[0]!.instance_name;
    const base = 900000000000 + Math.floor(Math.random() * 99_999_999);
    const lidA = `${base}@lid`;
    const lidB = `${base + 1}@lid`;
    const telA = `55479${String(base).slice(-8)}`;
    const telB = `55478${String(base).slice(-8)}`;
    const reg = (chat: string, l: string | null, tel: string | null, id: string, autor: string) =>
      webhook("SELECT app.whatsapp_registrar_mensagem($1, $2, $3, false, $4, $5, false, $2, $6, 'texto', 'oi', NULL, now())", [instancia, chat, l, tel, id, autor]);
    await reg(lidA, lidA, null, `A${base}`, telA); // o "nome" que chegou é o número
    await reg(lidB, lidB, null, `B${base}`, "Perfil B");
    await reg(`${telB}@s.whatsapp.net`, null, telB, `C${base}`, "Perfil B"); // a mesma pessoa, pelo número, sem o @lid
    const chatA = (await owner.query("SELECT id, name, phone FROM whatsapp_chats WHERE number_id = $1 AND jid = $2", [numero, lidA])).rows[0];
    expect(chatA).toMatchObject({ name: null, phone: null });
    const perfil = (j: string, nome: string, tel: string) =>
      owner.query("SELECT app.whatsapp_perfil_conversa($1, $2, $3, NULL, true, $4) AS mudou", [numero, j, nome, tel]).then((r) => r.rows[0]!.mudou);
    expect(await perfil(lidA, "Ana da Agenda", telA)).toBe(true);
    expect((await owner.query("SELECT name, phone FROM whatsapp_chats WHERE id = $1", [chatA.id])).rows[0]).toEqual({ name: "Ana da Agenda", phone: telA });
    expect(await perfil(lidB, "Bruno da Agenda", telB)).toBe(true);
    const deB = (await owner.query("SELECT jid, lid, name FROM whatsapp_chats WHERE number_id = $1 AND (jid IN ($2, $3) OR lid = $2)", [numero, lidB, `${telB}@s.whatsapp.net`])).rows;
    expect(deB).toEqual([{ jid: `${telB}@s.whatsapp.net`, lid: lidB, name: "Bruno da Agenda" }]);
    const msgs = (await owner.query("SELECT count(*)::int AS n FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id WHERE c.jid = $1 AND c.number_id = $2", [`${telB}@s.whatsapp.net`, numero])).rows[0].n;
    expect(msgs).toBe(2);
  });

  it("lida / não lida (0075): cada pessoa só a própria leitura, e só em conversa que vê", async () => {
    const chat = (await owner.query<{ id: string }>("SELECT id FROM whatsapp_chats WHERE number_id = $1 AND NOT is_group LIMIT 1", [numero])).rows[0]!.id;
    const marcar = (quem: string, naoLida: boolean) =>
      como(quem, sql`INSERT INTO whatsapp_chat_reads (chat_id, marked_unread) VALUES (${chat}::uuid, ${naoLida})
                     ON CONFLICT (person_id, chat_id) DO UPDATE SET marked_unread = EXCLUDED.marked_unread, read_at = now()`);
    await marcar(p.dono!, true);
    expect(await como(p.dono!, sql`SELECT marked_unread FROM whatsapp_chat_reads WHERE chat_id = ${chat}::uuid`)).toEqual([{ marked_unread: true }]);
    // Quem não vê a conversa não grava; ninguém lê a leitura de outra pessoa.
    await expect(marcar(p.outro!, true)).rejects.toThrow();
    expect(await como(p.outro!, sql`SELECT 1 FROM whatsapp_chat_reads WHERE chat_id = ${chat}::uuid`)).toEqual([]);
    expect(await como(p.admin!, sql`SELECT 1 FROM whatsapp_chat_reads WHERE chat_id = ${chat}::uuid`)).toEqual([]);
    await owner.query("DELETE FROM whatsapp_chat_reads WHERE chat_id = $1", [chat]);
  });

  it("dar nome ao contato: só o dono do número, só conversa com pessoa (0057)", async () => {
    const chat = (await owner.query<{ id: string }>("SELECT id FROM whatsapp_chats WHERE number_id = $1 AND NOT is_group LIMIT 1", [numero])).rows[0]!.id;
    const renomear = (quem: string, nome: string, id = chat) => como(quem, sql`SELECT app.whatsapp_renomear_contato(${id}::uuid, ${nome}) AS ok`).then((r) => r[0]!.ok);
    expect(await renomear(p.outro!, "Invasor")).toBe(false);
    expect(await renomear(p.admin!, "Admin")).toBe(false);
    expect(await renomear(p.dono!, "   ")).toBe(false);
    expect(await renomear(p.dono!, "  Cliente da Obra  ")).toBe(true);
    expect((await owner.query("SELECT name FROM whatsapp_chats WHERE id = $1", [chat])).rows[0].name).toBe("Cliente da Obra");
    // A sincronização (nem a agenda do celular) não sobrescreve um nome dado.
    await owner.query("SELECT app.whatsapp_perfil_conversa($1, (SELECT jid FROM whatsapp_chats WHERE id = $2), 'Outro nome', NULL, true, NULL)", [numero, chat]);
    expect((await owner.query("SELECT name FROM whatsapp_chats WHERE id = $1", [chat])).rows[0].name).toBe("Cliente da Obra");
  });

  it("conversa do histórico ou nova: só o dono do número, sem mensagens, data nunca no futuro nem para trás (0060)", async () => {
    const abrir = (quem: string, jid: string, ultima: string | null, previa: string | null = null, telefone: string | null = null) =>
      como(quem, sql`SELECT app.whatsapp_conversa_do_dono(${numero}::uuid, ${jid}, NULL, ${jid.endsWith("@g.us")}, ${telefone}, 'Fulano', ${ultima}::timestamptz, ${previa}) AS id`).then(
        (r) => r[0]!.id as string,
      );
    // A mensagem do Postgres (o Drizzle embrulha o erro com o texto da consulta).
    const erro = (x: Promise<unknown>) => x.then(() => "", (e: { cause?: { message?: string } }) => e.cause?.message ?? "");
    expect(await erro(abrir(p.outro!, "5547922220000@s.whatsapp.net", null))).toMatch(/Só o dono/);
    expect(await erro(abrir(p.admin!, "5547922220000@s.whatsapp.net", null))).toMatch(/Só o dono/);
    expect(await erro(abrir(p.dono!, "status@broadcast", null))).toMatch(/Conversa inválida/);
    expect(await erro(abrir(p.dono!, "5547922220000@s.whatsapp.net", null, null, "12a"))).toMatch(/Telefone inválido/);
    const id = await abrir(p.dono!, "5547922220000@s.whatsapp.net", "2024-01-02T10:00:00Z", "Bom dia", "5547922220000");
    const linha = () => owner.query("SELECT name, phone, last_message_at, last_preview FROM whatsapp_chats WHERE id = $1", [id]).then((r) => r.rows[0]);
    expect(await linha()).toMatchObject({ name: "Fulano", phone: "5547922220000", last_preview: "Bom dia" });
    // Mesma conversa; uma data mais antiga não volta a última mensagem; o futuro vira agora.
    expect(await abrir(p.dono!, "5547922220000@s.whatsapp.net", "2023-01-01T00:00:00Z", "Velha")).toBe(id);
    expect((await linha()).last_preview).toBe("Bom dia");
    await abrir(p.dono!, "5547922220000@s.whatsapp.net", "2999-01-01T00:00:00Z", "Futuro");
    expect(new Date((await linha()).last_message_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await owner.query("SELECT count(*)::int AS n FROM whatsapp_messages WHERE chat_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("status pelo número ou pelo @lid; só avança; avisa a tela marcado como status (0061)", async () => {
    const jid = "5547911112222@s.whatsapp.net";
    const lid = "998877665544332@lid";
    await webhook("SELECT app.whatsapp_registrar_mensagem($1, $2, $3, false, '5547911112222', 'ST1', true, NULL, NULL, 'texto', 'Olá', NULL, now())", [instancia, jid, lid]);
    const status = () => owner.query("SELECT m.status FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id WHERE c.jid = $1 AND m.wa_id = 'ST1'", [jid]).then((r) => r.rows[0].status);
    const ouvinte = new pg.Client({ connectionString: urls.owner });
    await ouvinte.connect();
    const avisos: string[] = [];
    ouvinte.on("notification", (n) => avisos.push(n.payload ?? ""));
    await ouvinte.query("LISTEN omni_whatsapp");
    try {
      await webhook("SELECT app.whatsapp_registrar_status($1, $2, 'ST1', 'entregue')", [instancia, jid]);
      expect(await status()).toBe("entregue");
      await webhook("SELECT app.whatsapp_registrar_status($1, $2, 'ST1', 'lida')", [instancia, lid]); // pelo @lid
      expect(await status()).toBe("lida");
      await webhook("SELECT app.whatsapp_registrar_status($1, $2, 'ST1', 'entregue')", [instancia, jid]); // não volta
      expect(await status()).toBe("lida");
      await new Promise((r) => setTimeout(r, 200));
      expect(avisos.map((a) => JSON.parse(a).status)).toEqual([true, true]); // só o que mudou
    } finally {
      await ouvinte.end();
    }
  });

  it("plano de fundo: cada pessoa o seu, geral e por conversa que ela vê; formato conferido (0061)", async () => {
    const chat = (await owner.query<{ id: string }>("SELECT id FROM whatsapp_chats WHERE number_id = $1 LIMIT 1", [numero])).rows[0]!.id;
    const fundos = (quem: string) => como(quem, sql`SELECT chat_id, fundo FROM whatsapp_fundos ORDER BY chat_id NULLS FIRST`);
    await como(p.dono!, sql`INSERT INTO whatsapp_fundos (person_id, chat_id, fundo) VALUES (${p.dono!}::uuid, NULL, 'areia|pontos')`);
    await como(p.dono!, sql`INSERT INTO whatsapp_fundos (person_id, chat_id, fundo) VALUES (${p.dono!}::uuid, ${chat}::uuid, '#1a2b3c|nenhum')`);
    expect(await fundos(p.dono!)).toEqual([
      { chat_id: null, fundo: "areia|pontos" },
      { chat_id: chat, fundo: "#1a2b3c|nenhum" },
    ]);
    expect(await fundos(p.outro!)).toEqual([]);
    // Conversa que não vê, fundo de outra pessoa, formato inválido, dois gerais.
    await expect(como(p.outro!, sql`INSERT INTO whatsapp_fundos (person_id, chat_id, fundo) VALUES (${p.outro!}::uuid, ${chat}::uuid, 'areia|nenhum')`)).rejects.toThrow();
    await expect(como(p.outro!, sql`INSERT INTO whatsapp_fundos (person_id, chat_id, fundo) VALUES (${p.dono!}::uuid, NULL, 'areia|nenhum')`)).rejects.toThrow();
    await expect(como(p.dono!, sql`UPDATE whatsapp_fundos SET fundo = 'url(x)|nenhum' WHERE chat_id IS NULL`)).rejects.toThrow();
    await expect(como(p.dono!, sql`INSERT INTO whatsapp_fundos (person_id, chat_id, fundo) VALUES (${p.dono!}::uuid, NULL, 'menta|grade')`)).rejects.toThrow();
    await como(p.dono!, sql`DELETE FROM whatsapp_fundos`);
    expect(await fundos(p.dono!)).toEqual([]);
  });

  it("conversa concluída: cada um conclui as suas, só de conversas que vê", async () => {
    const chat = sql`(SELECT id FROM whatsapp_chats WHERE number_id = ${numero}::uuid LIMIT 1)`;
    const concluidas = sql`SELECT person_id FROM whatsapp_chat_concluded WHERE chat_id = ${chat}`;
    await como(p.dono!, sql`INSERT INTO whatsapp_chat_concluded (person_id, chat_id) VALUES (${p.dono!}::uuid, ${chat})`);
    expect(await como(p.dono!, concluidas)).toHaveLength(1);
    expect(await como(p.membro!, concluidas)).toEqual([]); // a conclusão é de cada um
    await expect(como(p.dono!, sql`INSERT INTO whatsapp_chat_concluded (person_id, chat_id) VALUES (${p.membro!}::uuid, ${chat})`)).rejects.toThrow();
    await expect(como(p.outro!, sql`INSERT INTO whatsapp_chat_concluded (person_id, chat_id) VALUES (${p.outro!}::uuid, ${chat})`)).rejects.toThrow();
    await como(p.dono!, sql`DELETE FROM whatsapp_chat_concluded WHERE chat_id = ${chat}`);
    expect(await como(p.dono!, concluidas)).toEqual([]);
  });

  it("um aparelho em um número ativo só", async () => {
    // Outra pessoa conecta o mesmo aparelho no número dela.
    const segundo = String((await como(p.outro!, sql`SELECT app.criar_meu_whatsapp(${`omni-t${tag}b`}) AS id`))[0]!.id);
    await webhook("SELECT app.whatsapp_registrar_conexao($1, 'conectado', '5547988880000', NULL)", [`omni-t${tag}b`]);
    expect((await owner.query("SELECT phone, last_error FROM whatsapp_numbers WHERE id = $1", [segundo])).rows[0]).toEqual({
      phone: null,
      last_error: expect.stringContaining("já está pareado em outro número"),
    });
    await owner.query("UPDATE whatsapp_numbers SET status = 'removido' WHERE id = $1", [numero]);
    await webhook("SELECT app.whatsapp_registrar_conexao($1, 'conectado', '5547988880000', NULL)", [`omni-t${tag}b`]);
    expect((await owner.query("SELECT phone FROM whatsapp_numbers WHERE id = $1", [segundo])).rows[0]).toEqual({ phone: "5547988880000" });
  });

  it("grupo ligado à missão: quem vê o Interno lê só ele; ligar exige ver o número; histórico só de grupos", async () => {
    const tagM = `wm${tag}`;
    const missao = (
      await owner.query<{ id: string }>(
        "INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ($1, $2, 'Cliente W', true, now()) RETURNING id",
        [`9${tag.slice(0, 3).replace(/\D/g, "1")}`, tagM],
      )
    ).rows[0]!.id;
    p.campo = await pessoa("campo", "operacao");
    await owner.query("INSERT INTO mission_members (mission_id, channel, person_id, added_by) VALUES ($1, 'interno', $2, $3)", [missao, p.campo, p.admin]);
    // Um número ativo de novo para este teste.
    const n2 = (await owner.query<{ id: string }>("INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, status) VALUES ($1, 'Missões', 'operacao', $2, 'conectado') RETURNING id", [`omni-t${tag}m`, p.dono])).rows[0]!.id;
    await webhook("SELECT app.whatsapp_registrar_mensagem($1, '120363000000000099@g.us', NULL, true, NULL, 'GM1', false, '5547911110000@s.whatsapp.net', 'Líder', 'texto', 'Chegamos na obra', NULL, now())", [`omni-t${tag}m`]);
    await webhook("SELECT app.whatsapp_registrar_mensagem($1, '5547922220000@s.whatsapp.net', NULL, false, '5547922220000', 'PM1', false, '5547922220000@s.whatsapp.net', 'Particular', 'texto', 'conversa pessoal', NULL, now())", [`omni-t${tag}m`]);
    const grupo = (await owner.query<{ id: string }>("SELECT id FROM whatsapp_chats WHERE number_id = $1 AND is_group", [n2])).rows[0]!.id;
    const conversas = sql`SELECT jid FROM whatsapp_chats WHERE number_id = ${n2}::uuid ORDER BY jid`;

    expect(await como(p.campo!, conversas)).toEqual([]);
    await expect(como(p.campo!, sql`INSERT INTO whatsapp_chat_missions (chat_id, mission_id, linked_by) VALUES (${grupo}::uuid, ${missao}::uuid, ${p.campo}::uuid)`)).rejects.toThrow();
    await como(p.dono!, sql`INSERT INTO whatsapp_chat_missions (chat_id, mission_id, linked_by) VALUES (${grupo}::uuid, ${missao}::uuid, ${p.dono}::uuid)`);
    expect(await como(p.campo!, conversas)).toEqual([{ jid: "120363000000000099@g.us" }]); // a conversa pessoal continua fechada
    expect((await como(p.campo!, sql`SELECT body FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id WHERE c.number_id = ${n2}::uuid`)).map((r) => r.body)).toEqual(["Chegamos na obra"]);

    // Responder: só quem vê o número; ver pela missão não basta; Interno/Gerencial não têm origem válida.
    const responder = (quem: string, origem = "conversa") =>
      como(quem, sql`INSERT INTO whatsapp_outbox (chat_id, person_id, origem, body, mode) VALUES (${grupo}::uuid, ${quem}::uuid, ${origem}, 'Ok, obrigado', 'ensaio') RETURNING id`);
    await expect(responder(p.campo!)).rejects.toThrow();
    expect(await responder(p.dono!)).toHaveLength(1);
    await expect(responder(p.dono!, "interno")).rejects.toThrow();
    await expect(responder(p.dono!, "gerencial")).rejects.toThrow();

    // Histórico: só o dono do número pede (0056), e só grupos.
    const pedir = (quem: string, jids: string[]) =>
      como(quem, sql`INSERT INTO whatsapp_history_imports (number_id, group_jids, requested_by) VALUES (${n2}::uuid, ${`{${jids.join(",")}}`}::text[], ${quem}::uuid) RETURNING id`);
    await expect(pedir(p.admin!, ["120363000000000099@g.us"])).rejects.toThrow();
    await expect(pedir(p.campo!, ["120363000000000099@g.us"])).rejects.toThrow();
    await expect(pedir(p.dono!, ["5547922220000@s.whatsapp.net"])).rejects.toThrow();
    expect(await pedir(p.dono!, ["120363000000000099@g.us"])).toHaveLength(1);
    await owner.query("DELETE FROM missions WHERE id = $1", [missao]);
  });

  it("arquivo da mensagem: só para quem lê a conversa, e só mensagens com mídia", async () => {
    await webhook("SELECT app.whatsapp_registrar_mensagem($1, '120363000000000099@g.us', NULL, true, NULL, 'IMG1', false, NULL, 'Líder', 'imagem', 'foto da bomba', NULL, now())", [`omni-t${tag}m`]);
    const [img] = (await owner.query<{ id: string }>("SELECT m.id FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id JOIN whatsapp_numbers n ON n.id = c.number_id WHERE n.instance_name = $1 AND m.wa_id = 'IMG1'", [`omni-t${tag}m`])).rows;
    const [txt] = (await owner.query<{ id: string }>("SELECT m.id FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id JOIN whatsapp_numbers n ON n.id = c.number_id WHERE n.instance_name = $1 AND m.wa_id = 'GM1'", [`omni-t${tag}m`])).rows;
    const midia = (quem: string, id: string) => como(quem, sql`SELECT instancia, wa_id, tipo FROM app.midia_whatsapp(${id}::uuid)`);
    expect(await midia(p.dono!, img!.id)).toEqual([{ instancia: `omni-t${tag}m`, wa_id: "IMG1", tipo: "imagem" }]);
    expect(await midia(p.outro!, img!.id)).toEqual([]);
    expect(await midia(p.dono!, txt!.id)).toEqual([]);
  });

  it("sugestão recusada: só quem acompanha o número; arquivo na saída exige nome, tipo e tamanho juntos", async () => {
    const missao = (
      await owner.query<{ id: string }>(
        "INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ($1, $2, 'Cliente S', true, now()) RETURNING id",
        [`8${tag.slice(0, 3).replace(/\D/g, "2")}`, `ws${tag}`],
      )
    ).rows[0]!.id;
    const [grupo] = (await owner.query<{ id: string }>("SELECT c.id FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id WHERE n.instance_name = $1 AND c.is_group", [`omni-t${tag}m`])).rows;
    const recusar = (quem: string) => como(quem, sql`INSERT INTO whatsapp_link_dismissals (chat_id, mission_id, dismissed_by) VALUES (${grupo!.id}::uuid, ${missao}::uuid, ${quem}::uuid)`);
    await expect(recusar(p.outro!)).rejects.toThrow();
    await recusar(p.dono!);
    const enviarArquivo = (nome: string | null, mime: string | null, tamanho: number | null, corpo = "") =>
      como(p.dono!, sql`INSERT INTO whatsapp_outbox (chat_id, person_id, body, mode, file_name, file_mime, file_size) VALUES (${grupo!.id}::uuid, ${p.dono}::uuid, ${corpo}, 'ensaio', ${nome}, ${mime}, ${tamanho}) RETURNING id`);
    expect(await enviarArquivo("Medição.pdf", "application/pdf", 1200)).toHaveLength(1); // legenda vazia com arquivo
    await expect(enviarArquivo(null, null, null)).rejects.toThrow(); // sem texto e sem arquivo
    await expect(enviarArquivo("x.pdf", null, 10)).rejects.toThrow(); // arquivo incompleto
    await expect(enviarArquivo("grande.mp4", "video/mp4", 17 * 1024 * 1024)).rejects.toThrow(); // acima de 16 MB
    await owner.query("DELETE FROM missions WHERE id = $1", [missao]);
  });
});

