import { createPool, createWorkerDb, migrate, schema, withPerson } from "@omni/db";
import { GraphError, type MensagemGraph } from "@omni/integrations/graph";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { syncEmails, type FonteEmails } from "./outlook-emails.ts";

/** E-mails da missão no banco real (omni_test), com respostas sintéticas do Graph. Missão 7501 e caixas @omni.invalid são deste arquivo. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
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

const email = (id: string, assunto: string, extra: Partial<MensagemGraph> = {}): MensagemGraph => ({
  id,
  internetMessageId: `<${id}@exemplo.invalid>`,
  conversationId: "conv-1",
  subject: assunto,
  from: { emailAddress: { name: "Cliente", address: "contato@cliente.invalid" } },
  toRecipients: [{ emailAddress: { name: "Piloto", address: "piloto@omni.invalid" } }],
  ccRecipients: [],
  receivedDateTime: "2026-11-03T12:00:00Z",
  sentDateTime: "2026-11-03T11:59:00Z",
  bodyPreview: "prévia",
  hasAttachments: false,
  body: { contentType: "text", content: "corpo do e-mail" },
  ...extra,
});

type Resposta = Awaited<ReturnType<FonteEmails["mensagensDelta"]>>;
function fonte(respostas: Record<string, Array<Resposta | GraphError>>, chamadas: string[] = []): FonteEmails {
  return {
    mensagensDelta: async (caixa, pasta, link) => {
      chamadas.push(`${caixa}:${pasta}:${link ?? "inicio"}`);
      const fila = respostas[`${caixa}:${pasta}`] ?? [];
      const r = fila.shift() ?? { mensagens: [], removidas: [], continuar: null, deltaLink: link ?? "delta-vazio" };
      if (r instanceof GraphError) throw r;
      return r;
    },
  };
}

describe.skipIf(!available)("e-mails da missão", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let app: pg.Pool;
  let missao: string;
  let caixa: string;
  const db = () => createWorkerDb(worker);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    app = createPool(urls.app, 2);
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM mail_messages WHERE internet_message_id LIKE '%@exemplo.invalid>'");
    await owner.query("DELETE FROM mail_mailboxes WHERE email LIKE '%@omni.invalid'");
    // Caixas de outras pessoas do banco de teste (cadastradas no login, 0058) não entram nesta conta.
    await owner.query("UPDATE mail_mailboxes SET active = false WHERE email NOT LIKE '%@omni.invalid'");
    await owner.query("DELETE FROM sync_state WHERE source = 'graph'");
    await owner.query("DELETE FROM missions WHERE code = '7501'");
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, commercial_proposal_code, is_active, filtroapp_updated_at)
         VALUES ('7501', 'em-7501', 'Cliente E', '4711', true, now()) RETURNING id`,
      )
    ).rows[0]!.id;
    caixa = (await owner.query<{ id: string }>("INSERT INTO mail_mailboxes (email) VALUES ('piloto@omni.invalid') RETURNING id")).rows[0]!.id;
    await owner.query("INSERT INTO mail_mailboxes (email) VALUES ('fora@omni.invalid')");
  });

  afterAll(async () => {
    await owner?.query("DELETE FROM sync_state WHERE source = 'graph'");
    await Promise.all([owner?.end(), worker?.end(), app?.end()]);
  });

  it("guarda só o que se liga a uma missão, com o motivo; sem o corpo; cursor salvo; caixa sem acesso fica com o erro", async () => {
    const chamadas: string[] = [];
    const r = await syncEmails(
      db(),
      fonte(
        {
          "piloto@omni.invalid:inbox": [
            {
              mensagens: [email("e1", "Missão 7501 - cronograma"), email("e2", "Almoço sexta?"), email("e3", "Revisão", { body: { content: "Segue a proposta 4711" } })],
              removidas: [],
              continuar: null,
              deltaLink: "delta-inbox-1",
            },
          ],
          "fora@omni.invalid:inbox": [new GraphError("Graph respondeu 403", 403, "ErrorAccessDenied")],
        },
        chamadas,
      ),
      { now: () => new Date("2026-11-04T12:00:00Z") },
    );
    expect(r).toMatchObject({ caixas: 2, lidos: 3, guardados: 2, erros: 1 });
    const guardados = await db().select().from(schema.mailMessages).where(sql`internet_message_id LIKE '%@exemplo.invalid>'`);
    expect(guardados.map((m) => m.subject).sort()).toEqual(["Missão 7501 - cronograma", "Revisão"]); // "Almoço" nunca entra
    expect(guardados.every((m) => !("body" in m))).toBe(true);
    const motivos = await db().select().from(schema.mailMessageMissions).where(eq(schema.mailMessageMissions.missionId, missao));
    expect(motivos.map((x) => x.detalhe).sort()).toEqual(["Missão 7501 no assunto", "Proposta 4711 citada"]);
    const [c] = await db().select().from(schema.syncState).where(sql`source = 'graph' AND resource = ${`mail:${caixa}:inbox`}`);
    expect(c?.cursor).toBe("delta-inbox-1");
    const [fora] = await db().select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.email, "fora@omni.invalid"));
    expect(fora?.lastError).toMatch(/Omni - Caixas/);
  });

  it("o mesmo e-mail em duas pastas é uma linha; removido da caixa, sai do banco; delta vencido recomeça", async () => {
    const f = fonte({
      "piloto@omni.invalid:inbox": [{ mensagens: [email("e1", "Missão 7501")], removidas: [], continuar: null, deltaLink: "d1" }],
      "piloto@omni.invalid:sentitems": [{ mensagens: [email("e1-enviado", "Missão 7501", { internetMessageId: "<e1@exemplo.invalid>" })], removidas: [], continuar: null, deltaLink: "d2" }],
    });
    await syncEmails(db(), f);
    const linhas = await db().select().from(schema.mailMessages).where(eq(schema.mailMessages.internetMessageId, "<e1@exemplo.invalid>"));
    expect(linhas).toHaveLength(1);
    const copias = await db().select().from(schema.mailMessageCopies).where(eq(schema.mailMessageCopies.messageId, linhas[0]!.id));
    expect(copias.map((x) => x.folder).sort()).toEqual(["inbox", "sentitems"]);

    // Sumiu da Entrada: continua (está nos Enviados). Sumiu dos dois: sai.
    const chamadas: string[] = [];
    await syncEmails(
      db(),
      fonte(
        {
          "piloto@omni.invalid:inbox": [new GraphError("Graph respondeu 410", 410), { mensagens: [], removidas: ["e1"], continuar: null, deltaLink: "d3" }],
          "piloto@omni.invalid:sentitems": [{ mensagens: [], removidas: ["e1-enviado"], continuar: null, deltaLink: "d4" }],
        },
        chamadas,
      ),
    );
    expect(chamadas.filter((c) => c.startsWith("piloto@omni.invalid:inbox"))).toEqual(["piloto@omni.invalid:inbox:d1", "piloto@omni.invalid:inbox:inicio"]);
    expect(await db().select().from(schema.mailMessages).where(inArray(schema.mailMessages.id, [linhas[0]!.id]))).toEqual([]);
  });

  it("caixa única (0067): cabeçalho de todo e-mail da caixa pessoal, só para o dono; setor não guarda; avisa só o novo não lido; removido sai", async () => {
    const dono = (
      await owner.query<{ id: string }>(
        "INSERT INTO people (email, display_name) VALUES ('piloto@omni.invalid', 'Piloto') ON CONFLICT (email) DO UPDATE SET active = true RETURNING id",
      )
    ).rows[0]!.id;
    const outro = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('outro.' || gen_random_uuid() || '@omni.invalid', 'Outro') RETURNING id")).rows[0]!.id;
    const agora = new Date().toISOString();
    const ouvinte = new pg.Client({ connectionString: urls.owner });
    await ouvinte.connect();
    const avisos: string[] = [];
    ouvinte.on("notification", (n) => avisos.push(n.payload ?? ""));
    await ouvinte.query("LISTEN omni_email");
    try {
      await syncEmails(
        db(),
        fonte({
          "piloto@omni.invalid:inbox": [
            {
              mensagens: [
                email("ANT1", "Sem missão, antigo", { isRead: false }),
                email("NOVO1", "Sem missão, novo", { isRead: false, receivedDateTime: agora }),
                email("LIDO1", "Novo mas lido", { isRead: true, receivedDateTime: agora }),
              ],
              removidas: [],
              continuar: null,
              deltaLink: "d1",
            },
          ],
          "piloto@omni.invalid:sentitems": [
            { mensagens: [email("ENV1", "Enviado", { from: { emailAddress: { name: "Piloto", address: "piloto@omni.invalid" } } })], removidas: [], continuar: null, deltaLink: "d2" },
          ],
          "fora@omni.invalid:inbox": [{ mensagens: [email("SET1", "Da caixa de setor")], removidas: [], continuar: null, deltaLink: "d3" }],
        }),
      );
      const itens = (await owner.query("SELECT graph_id, folder, is_read, addresses, owner_person_id FROM mail_items WHERE graph_id IN ('ANT1','NOVO1','LIDO1','ENV1','SET1') ORDER BY graph_id")).rows;
      expect(itens.map((i) => [i.graph_id, i.folder, i.is_read])).toEqual([
        ["ANT1", "inbox", false],
        ["ENV1", "sentitems", true],
        ["LIDO1", "inbox", true],
        ["NOVO1", "inbox", false],
      ]); // a caixa de setor (sem pessoa) não guarda cabeçalhos
      expect(itens[0].addresses).toEqual(["contato@cliente.invalid", "piloto@omni.invalid"]);
      expect(itens.every((i) => i.owner_person_id === dono)).toBe(true);
      const colunas = (await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'mail_items'")).rows.map((c) => c.column_name);
      expect(colunas).not.toContain("body");
      // Só o dono lê.
      const ver = (quem: string) => withPerson(app, quem, (d) => d.execute(sql`SELECT graph_id FROM mail_items WHERE graph_id IN ('ANT1','NOVO1')`)).then((r) => r.rows.length);
      expect(await ver(dono)).toBe(2);
      expect(await ver(outro)).toBe(0);
      // Aviso: só o recém-chegado e não lido.
      await new Promise((r) => setTimeout(r, 200));
      const ids = (await owner.query("SELECT id FROM mail_items WHERE graph_id = 'NOVO1'")).rows.map((x) => x.id);
      expect(avisos.map((a) => JSON.parse(a).itemId)).toEqual(ids);
      // Removido da caixa: sai.
      await syncEmails(db(), fonte({ "piloto@omni.invalid:inbox": [{ mensagens: [], removidas: ["ANT1"], continuar: null, deltaLink: "d4" }] }));
      expect((await owner.query("SELECT count(*)::int AS n FROM mail_items WHERE graph_id = 'ANT1'")).rows[0].n).toBe(0);
    } finally {
      await ouvinte.end();
      await owner.query("DELETE FROM mail_items WHERE owner_person_id = ANY($1::uuid[])", [[dono, outro]]);
      await owner.query("DELETE FROM people WHERE id = $1", [outro]);
    }
  });

  it("só diretoria e gerentes leem; abrir registra quem abriu; caixas só para quem administra", async () => {
    await syncEmails(db(), fonte({ "piloto@omni.invalid:inbox": [{ mensagens: [email("e9", "Missão 7501")], removidas: [], continuar: null, deltaLink: "d" }] }));
    const pessoa = async (perfil: string) => {
      const id = (await owner.query<{ id: string }>(`INSERT INTO people (email, display_name) VALUES ('e.' || gen_random_uuid() || '@filtrovali.com.br', 'Pessoa') RETURNING id`)).rows[0]!.id;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      return id;
    };
    const [gerente, operacao, admin] = [await pessoa("gerente"), await pessoa("operacao"), await pessoa("admin")];
    const ler = (quem: string, q: ReturnType<typeof sql>) => withPerson(app, quem, (d) => d.execute<Record<string, unknown>>(q)).then((x) => x.rows);

    const lista = sql`SELECT id, motivos FROM app.emails_da_missao(${missao}::uuid)`;
    const [doGerente] = await ler(gerente, lista);
    expect(doGerente?.motivos).toEqual([{ motivo: "numero", detalhe: "Missão 7501 no assunto" }]);
    expect(await ler(operacao, lista)).toEqual([]);
    await expect(ler(gerente, sql`SELECT 1 FROM mail_messages`)).rejects.toThrow();

    const id = String(doGerente!.id);
    expect(await ler(operacao, sql`SELECT * FROM app.abrir_email(${id}::uuid)`)).toEqual([]);
    const [onde] = await ler(gerente, sql`SELECT * FROM app.abrir_email(${id}::uuid)`);
    expect(onde).toMatchObject({ mailbox: "piloto@omni.invalid", graph_id: "e9" });
    const leituras = await ler(gerente, sql`SELECT * FROM app.leituras_email(${id}::uuid)`);
    expect(leituras).toHaveLength(1); // a abertura negada não conta

    expect(await ler(gerente, sql`SELECT email FROM mail_mailboxes`)).toEqual([]);

    // Desvincular: só gestão; o e-mail sem missão sai; a sincronização não religa.
    expect((await ler(operacao, sql`SELECT app.desvincular_email(${id}::uuid, ${missao}::uuid) AS ok`))[0]?.ok).toBe(false);
    expect((await ler(gerente, sql`SELECT app.desvincular_email(${id}::uuid, ${missao}::uuid) AS ok`))[0]?.ok).toBe(true);
    expect(await ler(gerente, lista)).toEqual([]);
    await syncEmails(db(), fonte({ "piloto@omni.invalid:inbox": [{ mensagens: [email("e9", "Missão 7501 (lido)")], removidas: [], continuar: null, deltaLink: "d2" }] }));
    expect(await ler(gerente, lista)).toEqual([]);
    expect((await ler(admin, sql`SELECT email FROM mail_mailboxes WHERE email LIKE '%@omni.invalid'`)).length).toBe(2);
  });
});
