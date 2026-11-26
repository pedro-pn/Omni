import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import * as callSchema from "./schema.ts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import {
  auditLog,
  functionAssignments,
  missionResponsibles,
  missions,
  people,
  personProfiles,
  prismaCredentials,
  syncRuns,
} from "./schema.ts";
import { login, logout, resolveSession } from "./sessions.ts";

/**
 * Testes de permissão no banco real (omni_test). Em CI rodam sempre; localmente
 * são pulados se o Postgres do docker-compose.dev.yml não estiver de pé.
 */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
};

async function databaseAvailable(): Promise<boolean> {
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

const available = await databaseAvailable();
if (!available) console.warn("[rls] Postgres de teste indisponível — rode `npm run db:up`. Testes de RLS pulados.");

/** O Drizzle embrulha o erro do Postgres; a mensagem original fica em `cause`. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(error, "a operação deveria ter sido recusada").not.toBeNull();
  expect(`${error?.message} | ${error?.cause?.message ?? ""}`).toMatch(pattern);
}

describe.skipIf(!available)("RLS e sessões", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let worker: pg.Pool;
  let adminId: string;
  let commonId: string;

  const email = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@filtrovali.com.br`;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 4);
    worker = createPool(urls.worker, 2);

    const admin = await owner.query<{ id: string }>(
      "INSERT INTO people (email, display_name) VALUES ($1, 'Admin de teste') RETURNING id",
      [email("admin")],
    );
    adminId = admin.rows[0]!.id;
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'admin')", [adminId]);

    const common = await owner.query<{ id: string }>(
      "INSERT INTO people (email, display_name) VALUES ($1, 'Pessoa comum') RETURNING id",
      [email("comum")],
    );
    commonId = common.rows[0]!.id;
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
  });

  it("chamadas: somente o dono controla a linha; gravações exigem compartilhamento explícito até para gestão", async () => {
    const createPerson = async (profile: string) => {
      const id = (await owner.query<{ id: string }>("insert into people(email,display_name) values($1,'Pessoa de teste de chamadas') returning id", [email("calls")])).rows[0]!.id;
      await owner.query("insert into person_profiles(person_id,profile) values($1,$2)", [id, profile]); return id;
    };
    const a = await createPerson("operacao"), b = await createPerson("operacao"), director = await createPerson("diretoria");
    const number = (await owner.query<{ id: string }>("insert into whatsapp_numbers(instance_name,label,purpose,owner_person_id) values($1,'Linha de teste','outro',$2) returning id", [`omni-${randomUUID().replaceAll("-", "").slice(0, 10)}`, a])).rows[0]!.id;
    await owner.query("insert into whatsapp_number_members(number_id,person_id) values($1,$2)", [number, b]);
    for (const [person, expected] of [[a, true], [b, false], [adminId, false], [director, false]] as const) {
      const check = await withPerson(app, person, db => db.execute<{ ok: boolean }>(sql`select app.pode_usar_linha_chamada(${number}::uuid) as ok`));
      expect(check.rows[0]?.ok).toBe(expected);
    }
    await expectDbError(withPerson(app, a, db => db.insert(callSchema.whatsappCallPermissions).values({ personId: a, canRecord: true })), /row-level security/);
    await withPerson(app, adminId, db => db.insert(callSchema.whatsappCallPermissions).values({ personId: a, canRecord: true, updatedBy: adminId }));
    const record = randomUUID().replaceAll("-", "");
    const register = async (person: string, key = record) => (await app.query<{ ok: boolean }>(
      "select app.chamada_registrar($1,$2,$3,'5511999990000','saida','encerrada',now(),now(),now(),true,true,false,now()+interval '1 day') as ok", [number, person, key])).rows[0]!.ok;
    expect(await register(b)).toBe(false);
    expect(await register(a)).toBe(true);
    const call = (await owner.query<{ id: string }>("select id from whatsapp_calls where recording_id=$1", [record])).rows[0]!.id;
    // Retenção de 5 anos (0050): o banco aceita o vencimento informado pelo serviço de voz, com teto de 10 anos.
    const longa = randomUUID().replaceAll("-", ""), outra = randomUUID().replaceAll("-", "");
    await app.query("select app.chamada_registrar($1,$2,$3,'5511999990000','saida','encerrada',now(),now(),now(),true,true,false,now()+interval '5 years')", [number, a, longa]);
    await app.query("select app.chamada_registrar($1,$2,$3,'5511999990000','saida','encerrada',now(),now(),now(),true,true,false,now()+interval '50 years')", [number, a, outra]);
    const anos = (await owner.query<{ recording_id: string; anos: number }>("select recording_id, round(extract(epoch from expires_at - created_at) / 31557600)::int as anos from whatsapp_calls where recording_id in ($1, $2)", [longa, outra])).rows;
    expect(Object.fromEntries(anos.map((r) => [r.recording_id === longa ? "cinco" : "teto", r.anos]))).toEqual({ cinco: 5, teto: 10 });
    const visible = (person: string) => withPerson(app, person, db => db.select().from(callSchema.whatsappCalls).where(eq(callSchema.whatsappCalls.id, call)));
    expect(await visible(a)).toHaveLength(1);
    for (const person of [b, adminId, director]) expect(await visible(person)).toHaveLength(0);
    await expectDbError(withPerson(app, b, db => db.insert(callSchema.whatsappCallShares).values({ callId: call, personId: director, sharedBy: b })), /row-level security/);
    await withPerson(app, a, db => db.insert(callSchema.whatsappCallShares).values({ callId: call, personId: b, sharedBy: a }));
    expect(await visible(b)).toHaveLength(1);
    expect(await visible(adminId)).toHaveLength(0);
    await expectDbError(withPerson(app, b, db => db.insert(callSchema.whatsappCallShares).values({ callId: call, personId: director, sharedBy: b })), /row-level security/);
    await withPerson(app, b, db => db.delete(callSchema.whatsappCallShares).where(eq(callSchema.whatsappCallShares.callId, call)));
    expect(await visible(b)).toHaveLength(1); // destinatário não revoga nem administra compartilhamentos
    await withPerson(app, a, db => db.delete(callSchema.whatsappCallShares).where(eq(callSchema.whatsappCallShares.callId, call)));
    expect(await visible(b)).toHaveLength(0);
    await owner.query("update whatsapp_numbers set owner_person_id=$2 where id=$1", [number, b]);
    expect(await visible(a)).toHaveLength(1); expect(await visible(b)).toHaveLength(0); // troca da linha não transfere gravações
    expect(await register(a, randomUUID().replaceAll("-", ""))).toBe(false);
    expect(await register(a)).toBe(true); // replay final idempotente da chamada do dono anterior
    await withPerson(app, a, db => db.insert(callSchema.whatsappCallShares).values({ callId: call, personId: b, sharedBy: a }));
    // Resumo pela IA só a pedido do dono (0039): quem recebeu o compartilhamento não manda o áudio à OpenAI.
    const pedir = (person: string) => withPerson(app, person, db => db.execute<{ ok: boolean }>(sql`select app.pedir_resumo_chamada(${call}::uuid) as ok`)).then(r => r.rows[0]?.ok);
    expect(await pedir(b)).toBe(false);
    expect(await pedir(director)).toBe(false);
    expect(await pedir(a)).toBe(true);
    expect((await visible(a))[0]?.summaryStatus).toBe("pendente");
    expect(await pedir(a)).toBe(false); // já pedido: não volta para a fila
    await expectDbError(withPerson(app, a, db => db.update(callSchema.whatsappCalls).set({ summaryStatus: "pendente" }).where(eq(callSchema.whatsappCalls.id, call))), /permission denied/);
    // Transcrição (0062): o worker grava; vê quem ouve a gravação; resumida sem transcrição pode ser pedida de novo.
    await owner.query("update whatsapp_calls set summary_status='resumida', summary='{}'::jsonb, transcript=NULL where id=$1", [call]);
    expect(await pedir(a)).toBe(true);
    await owner.query("update whatsapp_calls set summary_status='resumida', transcript='Olá, tudo bem? Combinado amanhã.' where id=$1", [call]);
    expect(await pedir(a)).toBe(false); // já tem transcrição
    expect((await visible(b))[0]?.transcript).toBe("Olá, tudo bem? Combinado amanhã.");
    expect(await visible(director)).toHaveLength(0);
    await expectDbError(withPerson(app, a, db => db.update(callSchema.whatsappCalls).set({ transcript: "x" }).where(eq(callSchema.whatsappCalls.id, call))), /permission denied/);
    const refused = await withPerson(app, b, db => db.execute<{ ok: boolean }>(sql`select app.excluir_gravacao(${call}::uuid) as ok`));
    expect(refused.rows[0]?.ok).toBe(false);
    await withPerson(app, a, db => db.execute(sql`select app.excluir_gravacao(${call}::uuid)`));
    expect(await visible(b)).toHaveLength(0);
    expect((await visible(a))[0]?.audio).toBe(false);
    expect((await visible(a))[0]?.transcript).toBeNull(); // excluir apaga a transcrição junto
    expect((await visible(a))[0]?.summary).toBeNull();
  });

  it("os papéis do web e do worker não têm BYPASSRLS nem superusuário", async () => {
    const { rows } = await owner.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('omni_app', 'omni_worker')",
    );
    expect(rows).toHaveLength(2);
    for (const role of rows) {
      expect(role.rolbypassrls).toBe(false);
      expect(role.rolsuper).toBe(false);
    }
  });

  it("nenhuma função do esquema app fica aberta a PUBLIC (só GRANT explícito)", async () => {
    const { rows } = await owner.query<{ f: string }>(
      `SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND (p.proacl IS NULL OR EXISTS (
          SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))`,
    );
    expect(rows.map((r) => r.f)).toEqual([]);
  });

  it("toda tabela do esquema public tem RLS ligado (fora o controle das migrations)", async () => {
    const { rows } = await owner.query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> 'schema_migrations'`,
    );
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it("sem pessoa na transação, o web não vê ninguém", async () => {
    const rows = await withPerson(app, null, (db) => db.select().from(people));
    expect(rows).toHaveLength(0);
  });

  it("com pessoa logada, o web vê o diretório", async () => {
    const rows = await withPerson(app, commonId, (db) => db.select({ id: people.id }).from(people));
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([adminId, commonId]));
  });

  it("o web não lê a tabela de sessões", async () => {
    await expect(app.query("SELECT * FROM sessions")).rejects.toThrow(/permission denied/);
  });

  it("o web não vê nem mexe na fila de arquivos da retenção (0081)", async () => {
    await expect(app.query("SELECT * FROM arquivos_para_apagar")).rejects.toThrow(/permission denied/);
    await expect(app.query("INSERT INTO arquivos_para_apagar (sp_drive_id, sp_item_id, origem) VALUES ('d', 'i', 'canal')")).rejects.toThrow(/permission denied/);
  });

  it("pessoa comum não concede perfil; admin concede", async () => {
    await expectDbError(
      withPerson(app, commonId, (db) =>
        db.insert(personProfiles).values({ personId: commonId, profile: "diretoria", grantedBy: commonId }),
      ),
      /row-level security/,
    );

    await withPerson(app, adminId, (db) =>
      db.insert(personProfiles).values({ personId: commonId, profile: "gerente", grantedBy: adminId }),
    );
    const { rows } = await owner.query("SELECT 1 FROM person_profiles WHERE person_id = $1 AND profile = 'gerente'", [
      commonId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("diretoria não concede o perfil admin", async () => {
    const directorId = (
      await owner.query<{ id: string }>(
        "INSERT INTO people (email, display_name) VALUES ($1, 'Diretoria de teste') RETURNING id",
        [email("dir")],
      )
    ).rows[0]!.id;
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'diretoria')", [directorId]);

    await expectDbError(
      withPerson(app, directorId, (db) =>
        db.insert(personProfiles).values({ personId: commonId, profile: "admin", grantedBy: directorId }),
      ),
      /row-level security/,
    );
  });

  it("só quem administra configura funções da empresa", async () => {
    await expectDbError(
      withPerson(app, commonId, (db) =>
        db.insert(functionAssignments).values({ functionCode: "qualidade", personId: commonId, startsOn: "2026-10-26" }),
      ),
      /row-level security/,
    );

    await withPerson(app, adminId, (db) =>
      db.insert(functionAssignments).values({ functionCode: "qualidade", personId: commonId, startsOn: "2026-10-26" }),
    );
  });

  it("auditoria: só inserção, com o próprio autor, e leitura restrita", async () => {
    await withPerson(app, commonId, (db) => db.insert(auditLog).values({ actorPersonId: commonId, action: "teste" }));

    await expectDbError(
      withPerson(app, commonId, (db) => db.insert(auditLog).values({ actorPersonId: adminId, action: "falsificado" })),
      /row-level security/,
    );

    const visibleToCommon = await withPerson(app, commonId, (db) => db.select().from(auditLog));
    expect(visibleToCommon).toHaveLength(0);

    await expect(owner.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/somente inserção/);
    await expect(owner.query("DELETE FROM audit_log")).rejects.toThrow(/somente inserção/);
  });

  it("login cria a pessoa e a sessão; logout revoga", async () => {
    const mail = email("login");
    const { personId, token } = await login(app, {
      entraOid: randomUUID(),
      email: mail,
      displayName: "Pessoa Nova",
      userAgent: "vitest",
      ip: "127.0.0.1",
    });
    expect(await resolveSession(app, token)).toBe(personId);

    const fresh = await withPerson(app, personId, (db) => db.select().from(people).where(eq(people.id, personId)));
    expect(fresh[0]?.email).toBe(mail);

    await logout(app, token);
    expect(await resolveSession(app, token)).toBeNull();
  });

  it("e-mail já ligado a outra conta Microsoft é recusado", async () => {
    const mail = email("dup");
    await login(app, { entraOid: randomUUID(), email: mail, displayName: "A" });
    await expect(login(app, { entraOid: randomUUID(), email: mail, displayName: "B" })).rejects.toThrow(
      /outra conta Microsoft/,
    );
  });

  it("pessoa desativada perde a sessão e não entra de novo", async () => {
    const mail = email("off");
    const { personId, token } = await login(app, { entraOid: null, email: mail, displayName: "Sai" });
    await owner.query("UPDATE people SET active = false WHERE id = $1", [personId]);
    expect(await resolveSession(app, token)).toBeNull();
    await expect(login(app, { entraOid: null, email: mail, displayName: "Sai" })).rejects.toThrow(/desativada/);
  });

  it("token inválido não resolve", async () => {
    expect(await resolveSession(app, "nao-existe")).toBeNull();
    expect(await resolveSession(app, "")).toBeNull();
  });

  it("o worker lê pessoas sem precisar de pessoa na transação", async () => {
    const { rows } = await worker.query("SELECT id FROM people WHERE id = $1", [adminId]);
    expect(rows).toHaveLength(1);
  });

  it("credencial do Prisma: cada pessoa só vê e grava a própria", async () => {
    const credencial = (personId: string) => ({
      personId,
      environment: "sandbox" as const,
      tokenCiphertext: Buffer.from("cifrado"),
      scopes: ["feedback.write"],
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await withPerson(app, commonId, (db) => db.insert(prismaCredentials).values(credencial(commonId)));

    const doAdmin = await withPerson(app, adminId, (db) => db.select().from(prismaCredentials));
    expect(doAdmin.find((c) => c.personId === commonId)).toBeUndefined();
    const propria = await withPerson(app, commonId, (db) => db.select().from(prismaCredentials));
    expect(propria).toHaveLength(1);

    await expectDbError(
      withPerson(app, adminId, (db) => db.insert(prismaCredentials).values(credencial(commonId))),
      /row-level security/,
    );
  });

  describe("missões (espelho do filtroAPP)", () => {
    // Códigos 9xxx são deste teste; o teste do sync usa 8xxx.
    beforeAll(async () => {
      await owner.query("DELETE FROM missions WHERE code LIKE '9%'");
      await worker.query(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at)
         VALUES ('9001', 'rls-9001', 'Cliente RLS', true, now())`,
      );
      await worker.query(
        `INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at)
         SELECT id, 'LEADER', 'Líder RLS', 'lider.rls@filtrovali.com.br', now() FROM missions WHERE code = '9001'`,
      );
    });

    it("pessoa sem perfil não vê missões; com perfil vê", async () => {
      const semPerfil = (
        await owner.query<{ id: string }>(
          "INSERT INTO people (email, display_name) VALUES ($1, 'Recém-chegado') RETURNING id",
          [email("novo")],
        )
      ).rows[0]!.id;
      const nenhuma = await withPerson(app, semPerfil, (db) => db.select().from(missions).where(eq(missions.code, "9001")));
      expect(nenhuma).toHaveLength(0);
      const semResponsaveis = await withPerson(app, semPerfil, (db) => db.select().from(missionResponsibles));
      expect(semResponsaveis).toHaveLength(0);

      const vistas = await withPerson(app, adminId, (db) => db.select().from(missions).where(eq(missions.code, "9001")));
      expect(vistas).toHaveLength(1);
      const responsaveis = await withPerson(app, adminId, (db) =>
        db.select().from(missionResponsibles).where(eq(missionResponsibles.missionId, vistas[0]!.id)),
      );
      expect(responsaveis).toHaveLength(1);
    });

    it("o web não escreve em missões (só o worker)", async () => {
      await expectDbError(
        withPerson(app, adminId, (db) =>
          db.insert(missions).values({ code: "9002", filtroappProjectId: "rls-9002", clientName: "X", isActive: true, filtroappUpdatedAt: new Date() }),
        ),
        /permission denied/,
      );
      await expectDbError(
        withPerson(app, adminId, (db) => db.update(missions).set({ stage: "FINISHED" }).where(eq(missions.code, "9001"))),
        /permission denied/,
      );
    });

    it("histórico de sincronizações só para quem administra", async () => {
      await worker.query("INSERT INTO sync_runs (source, resource, status) VALUES ('teste', 'rls', 'ok')");
      const comum = await withPerson(app, commonId, (db) => db.select().from(syncRuns));
      expect(comum).toHaveLength(0);
      const admin = await withPerson(app, adminId, (db) => db.select().from(syncRuns));
      expect(admin.length).toBeGreaterThan(0);
    });
  });
});
