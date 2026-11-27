import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./client.ts";
import { migrate } from "./migrate.ts";

/**
 * Resumo por correspondente (0073): o gatilho em mail_items mantém o mesmo resultado da
 * consulta antiga da caixa única (remetente na Entrada, destinatários nos Enviados, sem o
 * próprio endereço), ao inserir, marcar como lido e apagar.
 */
const urls = { owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test" };
async function disponivel() {
  const c = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();

/** A consulta da caixa única antes do resumo (0067), para comparar — com a regra da 0092 (recebido só com o dono no Para). */
const ANTIGA = `
  WITH base AS (
    SELECT folder, from_address, from_name, to_recipients, subject, preview, coalesce(received_at, sent_at, created_at) AS em, is_read
      FROM mail_items WHERE owner_person_id = $1
  ), pares AS (
    SELECT from_address AS endereco, from_name AS nome, em, subject, preview, (NOT is_read) AS nao_lido FROM base
     WHERE folder = 'inbox' AND from_address IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(to_recipients) r WHERE lower(r->>'endereco') = $2)
    UNION ALL
    SELECT lower(r->>'endereco'), r->>'nome', em, subject, preview, false FROM base, jsonb_array_elements(to_recipients) r WHERE folder = 'sentitems'
  )
  SELECT endereco AS address,
         (array_agg(nome ORDER BY em DESC) FILTER (WHERE nome IS NOT NULL AND nome <> ''))[1] AS name,
         (array_agg(subject ORDER BY em DESC))[1] AS last_subject,
         count(*) FILTER (WHERE nao_lido)::int AS unread, count(*)::int AS total
    FROM pares WHERE endereco IS NOT NULL AND endereco <> $2
   GROUP BY endereco ORDER BY endereco`;

describe.skipIf(!available)("resumo por correspondente (caixa única)", () => {
  let owner: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const email = `dono-${tag}@correspondentes.invalid`;
  let dono = "";
  let caixa = "";

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    dono = (await owner.query("INSERT INTO people (email, display_name) VALUES ($1, 'Dono') RETURNING id", [email])).rows[0].id;
    caixa = (await owner.query("INSERT INTO mail_mailboxes (email, active) VALUES ($1, false) RETURNING id", [email])).rows[0].id;
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM mail_mailboxes WHERE id = $1", [caixa]);
    await owner?.end();
  });

  const item = (g: string, pasta: "inbox" | "sentitems", de: [string, string], para: [string, string][], quando: string, lido = true, cc: [string, string][] = []) =>
    owner.query(
      `INSERT INTO mail_items (mailbox_id, owner_person_id, graph_id, folder, from_name, from_address, to_recipients, cc_recipients, addresses, subject, preview, received_at, sent_at, is_read)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $12::jsonb, $8, $9, 'prévia ' || $9, $10, $10, $11)`,
      [
        caixa, dono, `${tag}-${g}`, pasta, de[0], de[1], JSON.stringify(para.map(([nome, endereco]) => ({ nome, endereco }))),
        [de[1], ...para.map((p) => p[1]), ...cc.map((p) => p[1])], `assunto ${g}`, quando, lido, JSON.stringify(cc.map(([nome, endereco]) => ({ nome, endereco }))),
      ],
    );
  const resumo = async () =>
    (await owner.query("SELECT address, name, last_subject, unread, total FROM mail_correspondents WHERE owner_person_id = $1 ORDER BY address", [dono])).rows;
  const antiga = async () => (await owner.query(ANTIGA, [dono, email])).rows;

  it("igual à consulta antiga ao receber, enviar, marcar como lido e apagar; o próprio endereço não entra", async () => {
    const eu: [string, string] = ["Dono", email];
    await item("1", "inbox", ["Ana Cliente", "ana@cli.exemplo"], [["Dono", email]], "2026-11-20T10:00:00Z", false);
    await item("2", "sentitems", eu, [["Ana", "ana@cli.exemplo"], ["Bruno", "bruno@cli.exemplo"]], "2026-11-21T10:00:00Z");
    await item("3", "inbox", ["", "ana@cli.exemplo"], [["Dono", email]], "2026-11-22T10:00:00Z", false); // sem nome: fica o último com nome
    await item("4", "inbox", ["Carla", "carla@forn.exemplo"], [["Dono", email], ["Ana", "ana@cli.exemplo"]], "2026-11-19T10:00:00Z"); // Ana em cópia/para não conta como recebido dela
    expect(await resumo()).toEqual(await antiga());
    expect((await resumo()).map((r) => [r.address, r.unread, r.total, r.last_subject])).toEqual([
      ["ana@cli.exemplo", 2, 3, "assunto 3"],
      ["bruno@cli.exemplo", 0, 1, "assunto 2"],
      ["carla@forn.exemplo", 0, 1, "assunto 4"],
    ]);
    // Marcar como lido (como a tela faz) atualiza o não lido.
    await owner.query("UPDATE mail_items SET is_read = true WHERE graph_id = $1", [`${tag}-1`]);
    expect(await resumo()).toEqual(await antiga());
    // Apagar o último e-mail de um correspondente volta para o anterior; o único, tira o correspondente.
    await owner.query("DELETE FROM mail_items WHERE graph_id IN ($1, $2)", [`${tag}-3`, `${tag}-4`]);
    expect(await resumo()).toEqual(await antiga());
    expect((await resumo()).map((r) => r.address)).toEqual(["ana@cli.exemplo", "bruno@cli.exemplo"]);
  });

  it("e-mail na conversa entre duas pessoas: um mandou e o outro está no Para; cópia não conta (0092)", async () => {
    const eu: [string, string] = ["Dono", email];
    const jo: [string, string] = ["Joel Colega", `joel-${tag}@correspondentes.invalid`];
    const terceiro: [string, string] = ["Terceiro", `terceiro-${tag}@cli.exemplo`];
    // De terceiro, com o dono e o colega em cópia: não é da conversa com o colega (o caso relatado).
    await item("c1", "inbox", terceiro, [["Fulano", "fulano@cli.exemplo"]], "2026-11-25T10:00:00Z", false, [eu, jo]);
    // Do colega, com o dono só em cópia: também não.
    await item("c2", "inbox", jo, [["Fulano", "fulano@cli.exemplo"]], "2026-11-25T11:00:00Z", false, [eu]);
    // Do dono para outra pessoa, com o colega em cópia: também não.
    await item("c3", "sentitems", eu, [["Fulano", "fulano@cli.exemplo"]], "2026-11-25T12:00:00Z", true, [jo]);
    expect((await resumo()).map((r) => r.address)).not.toContain(jo[1]);
    // Do colega PARA o dono (com outros no Para): é.
    await item("c4", "inbox", jo, [eu, ["Fulano", "fulano@cli.exemplo"]], "2026-11-25T13:00:00Z", false);
    // Do dono PARA o colega: é.
    await item("c5", "sentitems", eu, [jo], "2026-11-25T14:00:00Z");
    const doColega = (await resumo()).find((r) => r.address === jo[1]);
    expect(doColega).toMatchObject({ unread: 1, total: 2, last_subject: "assunto c5" });
    expect(await resumo()).toEqual(await antiga());

    // A mesma regra que a tela usa na linha do tempo e ao marcar como lido (app.email_da_conversa).
    const daConversa = (
      await owner.query(
        "SELECT graph_id FROM mail_items WHERE owner_person_id = $1 AND graph_id LIKE $2 AND app.email_da_conversa(folder, from_address, to_recipients, $3::text[], $4) ORDER BY graph_id",
        [dono, `${tag}-c%`, [jo[1]], email.toUpperCase()],
      )
    ).rows.map((r) => r.graph_id);
    expect(daConversa).toEqual([`${tag}-c4`, `${tag}-c5`]);
  });
});

