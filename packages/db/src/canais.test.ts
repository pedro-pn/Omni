import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import { missionMembers, missionMessageFiles, missionMessages, missionReads } from "./schema.ts";

/**
 * Permissões dos canais Interno e Gerencial (migration 0005), no Postgres real.
 * Missão 9101 é deste teste.
 */

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
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(error, "deveria ter sido recusado").not.toBeNull();
  expect(`${error?.message} | ${error?.cause?.message ?? ""}`).toMatch(pattern);
}

describe.skipIf(!available)("canais da missão", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let missionId: string;
  const ids: Record<"diretoria" | "lider" | "gestor" | "fora" | "novo", string> = {
    diretoria: "",
    lider: "",
    gestor: "",
    fora: "",
    novo: "",
  };

  const tag = randomUUID().slice(0, 6);
  const emailDe = (k: string) => `${k}-${tag}@filtrovali.com.br`;

  async function pessoa(chave: keyof typeof ids, perfil: string) {
    const { rows } = await owner.query<{ id: string }>(
      "INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id",
      [emailDe(chave), chave],
    );
    ids[chave] = rows[0]!.id;
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [ids[chave], perfil]);
  }

  const mensagem = (channel: "interno" | "gerencial", body: string, createdAt: string) =>
    owner.query(
      "INSERT INTO mission_messages (mission_id, channel, author_person_id, body, created_at) VALUES ($1, $2, NULL, $3, $4)",
      [missionId, channel, body, createdAt],
    );

  const lidas = (personId: string, channel: "interno" | "gerencial") =>
    withPerson(app, personId, (db) =>
      db
        .select({ body: missionMessages.body })
        .from(missionMessages)
        .where(and(eq(missionMessages.missionId, missionId), eq(missionMessages.channel, channel)))
        .orderBy(missionMessages.createdAt),
    ).then((rows) => rows.map((r) => r.body));

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 4);

    await owner.query("DELETE FROM missions WHERE code = '9101'");
    const m = await owner.query<{ id: string }>(
      `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at)
       VALUES ('9101', 'canais-9101', 'Cliente Canais', true, now()) RETURNING id`,
    );
    missionId = m.rows[0]!.id;

    await pessoa("diretoria", "diretoria");
    await pessoa("lider", "lider_projetos");
    await pessoa("gestor", "gerente");
    await pessoa("fora", "operacao");
    await pessoa("novo", "operacao");

    await owner.query(
      `INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES
       ($1, 'LEADER', 'Líder', $2, now()), ($1, 'PLANNER', 'Gestor', $3, now())`,
      [missionId, emailDe("lider"), emailDe("gestor")],
    );

    await mensagem("interno", "antiga", "2026-10-01T12:00:00Z");
    await mensagem("gerencial", "estratégia", "2026-10-01T12:00:00Z");
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("quem não é membro não lê nem escreve no Interno", async () => {
    expect(await lidas(ids.fora, "interno")).toEqual([]);
    await falha(
      withPerson(app, ids.fora, (db) =>
        db.insert(missionMessages).values({ missionId, channel: "interno", authorPersonId: ids.fora, body: "oi" }),
      ),
      /row-level security/,
    );
  });

  it("líder de projetos e gestor de contrato do filtroAPP são membros do Interno, com todo o histórico", async () => {
    expect(await lidas(ids.lider, "interno")).toContain("antiga");
    expect(await lidas(ids.gestor, "interno")).toContain("antiga");
    await withPerson(app, ids.lider, (db) =>
      db.insert(missionMessages).values({ missionId, channel: "interno", authorPersonId: ids.lider, body: "do líder" }),
    );
  });

  it("o Gerencial fica fechado para quem a diretoria não colocou", async () => {
    expect(await lidas(ids.lider, "gerencial")).toEqual([]);
    expect(await lidas(ids.gestor, "gerencial")).toEqual([]);
  });

  it("a diretoria vê os dois canais", async () => {
    expect(await lidas(ids.diretoria, "interno")).toContain("antiga");
    expect(await lidas(ids.diretoria, "gerencial")).toEqual(["estratégia"]);
  });

  it("arquivo da mensagem: vê quem lê a mensagem; só o autor anexa (0063)", async () => {
    const [m] = await withPerson(app, ids.lider, (db) =>
      db.insert(missionMessages).values({ missionId, channel: "interno", authorPersonId: ids.lider, body: "relatorio.pdf" }).returning({ id: missionMessages.id }),
    );
    const arquivo = (messageId: string) => ({ messageId, name: "relatorio.pdf", mime: "application/pdf", size: 1234, spDriveId: "b!drive", spItemId: "ITEM1" });
    await withPerson(app, ids.lider, (db) => db.insert(missionMessageFiles).values(arquivo(m!.id)));
    const ver = (quem: string) => withPerson(app, quem, (db) => db.select({ nome: missionMessageFiles.name }).from(missionMessageFiles).where(eq(missionMessageFiles.messageId, m!.id)));
    expect(await ver(ids.gestor)).toEqual([{ nome: "relatorio.pdf" }]); // membro do Interno
    expect(await ver(ids.fora)).toEqual([]);
    await falha(withPerson(app, ids.gestor, (db) => db.insert(missionMessageFiles).values(arquivo(m!.id))), /row-level security/);
    await falha(withPerson(app, ids.fora, (db) => db.insert(missionMessageFiles).values(arquivo(m!.id))), /row-level security/);
    // Arquivo numa mensagem do Gerencial: o líder (fora do Gerencial) não vê.
    const g = await owner.query<{ id: string }>("INSERT INTO mission_messages (mission_id, channel, author_person_id, body) VALUES ($1, 'gerencial', $2, 'x') RETURNING id", [missionId, ids.diretoria]);
    await owner.query("INSERT INTO mission_message_files (message_id, name, mime, size, sp_drive_id, sp_item_id) VALUES ($1, 'g.pdf', 'application/pdf', 1, 'b', 'i')", [g.rows[0]!.id]);
    expect(await withPerson(app, ids.lider, (db) => db.select().from(missionMessageFiles).where(eq(missionMessageFiles.messageId, g.rows[0]!.id)))).toEqual([]);
    await owner.query("DELETE FROM mission_messages WHERE id = ANY($1::uuid[])", [[m!.id, g.rows[0]!.id]]);
  });

  it("líder adiciona no Interno, mas não no Gerencial; gestor não adiciona", async () => {
    await falha(
      withPerson(app, ids.lider, (db) =>
        db.insert(missionMembers).values({ missionId, channel: "gerencial", personId: ids.novo, addedBy: ids.lider }),
      ),
      /row-level security/,
    );
    await falha(
      withPerson(app, ids.gestor, (db) =>
        db.insert(missionMembers).values({ missionId, channel: "interno", personId: ids.novo, addedBy: ids.gestor }),
      ),
      /row-level security/,
    );
  });

  it("membro 'só a partir de agora' não vê o que veio antes", async () => {
    const agora = new Date();
    await withPerson(app, ids.lider, (db) =>
      db.insert(missionMembers).values({ missionId, channel: "interno", personId: ids.novo, addedBy: ids.lider, historySince: agora }),
    );
    await mensagem("interno", "depois de entrar", new Date(agora.getTime() + 1000).toISOString());
    const vistas = await lidas(ids.novo, "interno");
    expect(vistas).toContain("depois de entrar");
    expect(vistas).not.toContain("antiga");
  });

  it("membro comum não escreve mensagem de sistema", async () => {
    await falha(
      withPerson(app, ids.novo, (db) =>
        db.insert(missionMessages).values({ missionId, channel: "interno", authorPersonId: ids.novo, kind: "sistema", body: "x" }),
      ),
      /row-level security/,
    );
  });

  it("ninguém escreve em nome de outra pessoa", async () => {
    await falha(
      withPerson(app, ids.lider, (db) =>
        db.insert(missionMessages).values({ missionId, channel: "interno", authorPersonId: ids.gestor, body: "falso" }),
      ),
      /row-level security/,
    );
  });

  it("membro removido perde o acesso", async () => {
    await withPerson(app, ids.diretoria, (db) =>
      db
        .update(missionMembers)
        .set({ removedAt: new Date(), removedBy: ids.diretoria })
        .where(and(eq(missionMembers.missionId, missionId), eq(missionMembers.personId, ids.novo))),
    );
    expect(await lidas(ids.novo, "interno")).toEqual([]);
  });

  it("diretoria coloca alguém no Gerencial com todo o histórico", async () => {
    await withPerson(app, ids.diretoria, (db) =>
      db.insert(missionMembers).values({ missionId, channel: "gerencial", personId: ids.gestor, addedBy: ids.diretoria }),
    );
    expect(await lidas(ids.gestor, "gerencial")).toEqual(["estratégia"]);
  });

  it("marcação de leitura é só da própria pessoa", async () => {
    await withPerson(app, ids.lider, (db) =>
      db.insert(missionReads).values({ missionId, channel: "interno", personId: ids.lider, lastReadAt: new Date() }),
    );
    await falha(
      withPerson(app, ids.lider, (db) =>
        db.insert(missionReads).values({ missionId, channel: "interno", personId: ids.gestor, lastReadAt: new Date() }),
      ),
      /row-level security/,
    );
    const daDiretoria = await withPerson(app, ids.diretoria, (db) => db.select().from(missionReads));
    expect(daDiretoria.find((r) => r.personId === ids.lider)).toBeUndefined();
  });
});
