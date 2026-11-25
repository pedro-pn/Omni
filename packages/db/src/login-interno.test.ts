import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import { hashSessionToken, loginInterno, resolveSessionComTermos } from "./sessions.ts";

/** Login interno (0078): só admin cria, senha conferida no banco, bloqueio, troca obrigatória, sem e-mail. */

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

describe.skipIf(!available)("login interno", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let admin = "";
  let gerente = "";
  const tag = randomUUID().slice(0, 6);
  const login = `campo.${tag}`;
  const SENHA = "provisoria-123";

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 3);
    const nova = async (nome: string, perfil: string) => {
      const id = (await owner.query("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, nome])).rows[0].id;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      return id as string;
    };
    admin = await nova("admin", "admin");
    gerente = await nova("gerente", "gerente");
  });
  afterAll(async () => {
    // O registro de auditoria prende a pessoa: só desativa (e-mails com a marca deste arquivo).
    await owner?.query("UPDATE people SET active = false WHERE email LIKE $1 OR email = $2", [`%-${tag}@filtrovali.com.br`, `${login}@interno.omni.invalid`]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  const criar = (quem: string, l: string, senha = SENHA) => withPerson(app, quem, (db) => db.execute<{ id: string }>(sql`SELECT app.criar_acesso_interno('Pessoa do Campo', ${l}, ${senha}) AS id`));
  const entrar = (senha: string, l = login) => loginInterno(app, { login: l, senha, ip: "10.0.0.1" });

  it("só admin cria; usuário único; senha fraca recusada; ninguém lê as senhas pela tabela", async () => {
    await falha(criar(gerente, `x.${tag}`), /sem permissão/);
    await falha(criar(admin, `fraca.${tag}`, "curta1"), /senha fraca/);
    await falha(criar(admin, "Maiúsculo"), /usuário inválido/);
    const id = (await criar(admin, login)).rows[0]!.id;
    await falha(criar(admin, login), /usuário já existe/);
    const p = (await owner.query("SELECT email, acesso FROM people WHERE id = $1", [id])).rows[0];
    expect(p).toEqual({ email: `${login}@interno.omni.invalid`, acesso: "interno" });
    await falha(app.query("SELECT password_hash FROM internal_credentials"), /permission denied/);
    // A lista da Administração vê o usuário, nunca o hash; quem não é admin não vê nada.
    expect((await withPerson(app, admin, (db) => db.execute(sql`SELECT * FROM app.logins_internos() WHERE person_id = ${id}::uuid`))).rows).toEqual([
      { person_id: id, login, must_change: true, locked_until: null },
    ]);
    expect((await withPerson(app, gerente, (db) => db.execute(sql`SELECT * FROM app.logins_internos()`))).rows).toEqual([]);
  });

  it("entra com a senha provisória numa sessão curta, que só abre a troca; troca e passa a valer o prazo normal", async () => {
    expect(await entrar("errada-12345")).toMatchObject({ resultado: "invalido", token: null });
    expect(await loginInterno(app, { login: `nao.existe.${tag}`, senha: SENHA })).toMatchObject({ resultado: "invalido", token: null });
    const r = await entrar(SENHA);
    expect(r.resultado).toBe("trocar_senha");
    const s = await resolveSessionComTermos(app, r.token, "qualquer");
    expect(s).toMatchObject({ personId: r.personId, senhaPendente: true, acesso: "interno" });
    const minutos = (await owner.query("SELECT extract(epoch FROM expires_at - now()) / 60 AS m FROM sessions WHERE token_hash = $1", [hashSessionToken(r.token!)])).rows[0].m;
    expect(Number(minutos)).toBeLessThanOrEqual(30);
    // Sem caixa de e-mail e sem o módulo E-mail; o resto liberado.
    expect((await owner.query("SELECT count(*)::int AS n FROM mail_mailboxes WHERE email = $1", [`${login}@interno.omni.invalid`])).rows[0].n).toBe(0);
    const modulo = (m: string) => withPerson(app, r.personId!, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.modulo_liberado(${m}) AS ok`)).then((x) => x.rows[0]!.ok);
    expect(await modulo("emails")).toBe(false);
    expect(await modulo("tarefas")).toBe(true);
    // Trocar: senha atual errada, fraca ou igual não passam.
    const trocar = (atual: string, nova: string) =>
      withPerson(app, r.personId!, (db) => db.execute(sql`SELECT app.trocar_minha_senha(${atual}, ${nova}, ${hashSessionToken(r.token!)}, '12 hours'::interval)`));
    await falha(trocar("errada-12345", "minha-senha-1"), /senha atual não confere/);
    await falha(trocar(SENHA, "semnumero-aqui"), /senha fraca/);
    await falha(trocar(SENHA, SENHA), /senha igual/);
    const outra = await entrar(SENHA); // outra sessão aberta, que sai na troca
    await trocar(SENHA, "minha-senha-1");
    expect(await resolveSessionComTermos(app, r.token, "qualquer")).toMatchObject({ senhaPendente: false });
    expect(await resolveSessionComTermos(app, outra.token, "qualquer")).toBeNull();
    expect(await entrar(SENHA)).toMatchObject({ resultado: "invalido" });
    expect(await entrar("minha-senha-1")).toMatchObject({ resultado: "ok" });
  });

  it("5 erros seguidos bloqueiam (mesmo com a senha certa); a Administração redefine, desbloqueia e derruba as sessões", async () => {
    const aberta = await entrar("minha-senha-1");
    for (let i = 0; i < 4; i += 1) expect((await entrar(`errada-${i}-xyz`)).resultado).toBe("invalido");
    expect((await entrar("errada-5-xyz")).resultado).toBe("bloqueado");
    expect((await entrar("minha-senha-1")).resultado).toBe("bloqueado");
    const id = aberta.personId!;
    await falha(withPerson(app, gerente, (db) => db.execute(sql`SELECT app.redefinir_senha_interna(${id}::uuid, 'nova-provisoria-9')`)), /sem permissão/);
    await withPerson(app, admin, (db) => db.execute(sql`SELECT app.redefinir_senha_interna(${id}::uuid, 'nova-provisoria-9')`));
    expect(await resolveSessionComTermos(app, aberta.token, "qualquer")).toBeNull();
    expect((await entrar("nova-provisoria-9")).resultado).toBe("trocar_senha");
    // Desativada pela Administração: não entra.
    await owner.query("UPDATE people SET active = false WHERE id = $1", [id]);
    expect((await entrar("nova-provisoria-9")).resultado).toBe("desativada");
    // Conta Microsoft não vira interna pela redefinição.
    await falha(withPerson(app, admin, (db) => db.execute(sql`SELECT app.redefinir_senha_interna(${gerente}::uuid, 'nova-provisoria-9')`)), /não é uma conta interna/);
  });
});
