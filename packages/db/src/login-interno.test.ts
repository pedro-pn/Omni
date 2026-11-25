import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import { hashSessionToken, loginInterno, novoTokenDeLink, resolveSessionComTermos } from "./sessions.ts";

/** Login interno (0078): só admin cria, senha criada pela pessoa num link de uso único, bloqueio, recuperação só com e-mail pessoal confirmado, sem e-mail. */

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
  let pessoa = "";
  const tag = randomUUID().slice(0, 6);
  const login = `campo.${tag}`;
  const SENHA = "minha-senha-1";

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

  const criar = (quem: string, l: string, hash: Buffer) => withPerson(app, quem, (db) => db.execute<{ id: string }>(sql`SELECT app.criar_acesso_interno('Pessoa do Campo', ${l}, ${hash}) AS id`));
  const entrar = (senha: string, l = login) => loginInterno(app, { login: l, senha, ip: "10.0.0.1" });
  const usar = (token: string, senha: string) => app.query("SELECT app.usar_link_de_senha($1, $2) AS login", [hashSessionToken(token), senha]);
  const verLink = async (token: string) => (await app.query("SELECT * FROM app.link_interno($1)", [hashSessionToken(token)])).rows[0];

  it("só admin cria, sem senha; o link (7 dias, uso único) cria a senha e devolve o usuário; ninguém lê as tabelas", async () => {
    const link = novoTokenDeLink();
    await falha(criar(gerente, `x.${tag}`, novoTokenDeLink().hash), /sem permissão/);
    await falha(criar(admin, "Maiúsculo", novoTokenDeLink().hash), /usuário inválido/);
    pessoa = (await criar(admin, login, link.hash)).rows[0]!.id;
    await falha(criar(admin, login, novoTokenDeLink().hash), /usuário já existe/);
    expect((await owner.query("SELECT email, acesso FROM people WHERE id = $1", [pessoa])).rows[0]).toEqual({ email: `${login}@interno.omni.invalid`, acesso: "interno" });
    await falha(app.query("SELECT password_hash FROM internal_credentials"), /permission denied/);
    await falha(app.query("SELECT token_hash FROM internal_links"), /permission denied/);
    // Sem senha ainda: não entra (como usuário inexistente).
    expect(await entrar("qualquer-coisa-1")).toMatchObject({ resultado: "invalido", token: null });
    const dias = (await owner.query("SELECT extract(epoch FROM expires_at - now()) / 86400 AS d FROM internal_links WHERE token_hash = $1", [link.hash])).rows[0].d;
    expect(Math.round(Number(dias))).toBe(7);
    expect(await verLink(link.token)).toEqual({ tipo: "senha", nome: "Pessoa do Campo", login, valido: true });
    await falha(usar(link.token, "curta1"), /senha fraca/);
    expect((await usar(link.token, SENHA)).rows[0].login).toBe(login);
    // Uso único: o link não vale de novo e não mostra mais nada.
    await falha(usar(link.token, "outra-senha-2"), /link inválido/);
    expect(await verLink(link.token)).toEqual({ tipo: "senha", nome: null, login: null, valido: false });
    expect(await verLink(novoTokenDeLink().token)).toBeUndefined();
    // Admin vê o estado, nunca o hash nem o e-mail pessoal.
    expect((await withPerson(app, admin, (db) => db.execute(sql`SELECT * FROM app.logins_internos() WHERE person_id = ${pessoa}::uuid`))).rows).toEqual([
      { person_id: pessoa, login, tem_senha: true, link_vale_ate: null, locked_until: null, tem_email_recuperacao: false },
    ]);
    expect((await withPerson(app, gerente, (db) => db.execute(sql`SELECT * FROM app.logins_internos()`))).rows).toEqual([]);
  });

  it("entra; sem caixa de e-mail e sem o módulo E-mail; 5 erros bloqueiam (mesmo com a senha certa)", async () => {
    const r = await entrar(SENHA);
    expect(r.resultado).toBe("ok");
    expect(await resolveSessionComTermos(app, r.token, "qualquer")).toMatchObject({ personId: pessoa, acesso: "interno" });
    expect((await owner.query("SELECT count(*)::int AS n FROM mail_mailboxes WHERE email = $1", [`${login}@interno.omni.invalid`])).rows[0].n).toBe(0);
    const modulo = (m: string) => withPerson(app, pessoa, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.modulo_liberado(${m}) AS ok`)).then((x) => x.rows[0]!.ok);
    expect(await modulo("emails")).toBe(false);
    expect(await modulo("tarefas")).toBe(true);
    for (let i = 0; i < 4; i += 1) expect((await entrar(`errada-${i}-xyz`)).resultado).toBe("invalido");
    expect((await entrar("errada-5-xyz")).resultado).toBe("bloqueado");
    expect((await entrar(SENHA)).resultado).toBe("bloqueado");
    await owner.query("UPDATE internal_credentials SET locked_until = now() - interval '1 second' WHERE person_id = $1", [pessoa]);
    expect((await entrar(SENHA)).resultado).toBe("ok");
  });

  it("esqueci a senha só com e-mail pessoal confirmado (1 hora, 3 por hora); a senha atual vale até usar o link", async () => {
    const pedir = () => app.query<{ email: string | null }>("SELECT app.pedir_recuperacao($1, $2) AS email", [login, novoTokenDeLink().hash]).then((x) => x.rows[0]!.email);
    expect(await pedir()).toBeNull(); // sem e-mail pessoal: nada
    expect((await app.query("SELECT app.pedir_recuperacao($1, $2) AS email", [`nao.existe.${tag}`, novoTokenDeLink().hash])).rows[0].email).toBeNull();
    // Cadastrar o e-mail pede a senha atual e só vale confirmado.
    const confirmar = novoTokenDeLink();
    const pedirConfirmacao = (senha: string, email: string, hash: Buffer) => withPerson(app, pessoa, (db) => db.execute(sql`SELECT app.pedir_confirmacao_de_email(${senha}, ${email}, ${hash})`));
    await falha(pedirConfirmacao("errada-123456", "pessoal@exemplo.com", confirmar.hash), /senha atual não confere/);
    await falha(pedirConfirmacao(SENHA, "nao-e-email", novoTokenDeLink().hash), /e-mail inválido/);
    await pedirConfirmacao(SENHA, "Pessoal@Exemplo.com", confirmar.hash);
    expect(await pedir()).toBeNull(); // ainda não confirmado
    expect((await app.query("SELECT app.confirmar_email_pelo_link($1) AS login", [confirmar.hash])).rows[0].login).toBe(login);
    await falha(app.query("SELECT app.confirmar_email_pelo_link($1)", [confirmar.hash]), /link inválido/);
    // Recuperar: o link vai para o e-mail confirmado; a senha atual vale até usar o link.
    const rec = novoTokenDeLink();
    expect((await app.query("SELECT app.pedir_recuperacao($1, $2) AS email", [login.toUpperCase(), rec.hash])).rows[0].email).toBe("pessoal@exemplo.com");
    const horas = (await owner.query("SELECT extract(epoch FROM expires_at - now()) / 3600 AS h FROM internal_links WHERE token_hash = $1", [rec.hash])).rows[0].h;
    expect(Math.round(Number(horas))).toBe(1);
    expect((await entrar(SENHA)).resultado).toBe("ok");
    const aberta = await entrar(SENHA);
    expect(await verLink(rec.token)).toMatchObject({ tipo: "recuperar", valido: true });
    await usar(rec.token, "senha-nova-22");
    expect((await entrar(SENHA)).resultado).toBe("invalido");
    expect((await entrar("senha-nova-22")).resultado).toBe("ok");
    expect(await resolveSessionComTermos(app, aberta.token, "qualquer")).toBeNull(); // sessões antigas saem
    // No máximo 3 pedidos por hora.
    expect(await pedir()).not.toBeNull();
    expect(await pedir()).not.toBeNull();
    expect(await pedir()).toBeNull();
  });

  it("a Administração gera um link novo: a senha atual deixa de valer e as sessões saem; conta Microsoft não", async () => {
    const aberta = await entrar("senha-nova-22");
    const link = novoTokenDeLink();
    await falha(withPerson(app, gerente, (db) => db.execute(sql`SELECT app.novo_link_de_senha(${pessoa}::uuid, ${link.hash})`)), /sem permissão/);
    await withPerson(app, admin, (db) => db.execute(sql`SELECT app.novo_link_de_senha(${pessoa}::uuid, ${link.hash})`));
    expect(await resolveSessionComTermos(app, aberta.token, "qualquer")).toBeNull();
    expect((await entrar("senha-nova-22")).resultado).toBe("invalido");
    await usar(link.token, "terceira-senha-3");
    expect((await entrar("terceira-senha-3")).resultado).toBe("ok");
    await falha(withPerson(app, admin, (db) => db.execute(sql`SELECT app.novo_link_de_senha(${gerente}::uuid, ${novoTokenDeLink().hash})`)), /não é uma conta interna/);
    // Desativada: não entra e o link não vale.
    const outro = novoTokenDeLink();
    await withPerson(app, admin, (db) => db.execute(sql`SELECT app.novo_link_de_senha(${pessoa}::uuid, ${outro.hash})`));
    await owner.query("UPDATE people SET active = false WHERE id = $1", [pessoa]);
    await falha(usar(outro.token, "quarta-senha-44"), /link inválido/);
  });
});
