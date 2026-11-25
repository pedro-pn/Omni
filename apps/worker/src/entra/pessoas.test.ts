import { randomUUID } from "node:crypto";

import { createPool, createWorkerDb, migrate } from "@omni/db";
import { GraphError, type UsuarioEntra } from "@omni/integrations/graph";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sincronizarPessoasDoEntra, type FonteEntra } from "./pessoas.ts";

/** Pessoas pelo Entra (0049): app.entra_sincronizar_pessoa, app.entra_encerrar_ausentes e o job. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
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

const APP = "11111111-2222-4333-8444-555555555555";
const tag = randomUUID().slice(0, 8);
const email = (n: string) => `${n}-${tag}@filtrovali.com.br`;
const u = (nome: string, extra: Partial<UsuarioEntra> = {}): UsuarioEntra & { email: string } => ({ id: randomUUID(), nome, ativa: true, convidada: false, ...extra, email: email(nome) });

function fonte(estado: { diretas: UsuarioEntra[]; grupo: UsuarioEntra[]; grupoFalha?: boolean; appFalha?: boolean }): FonteEntra {
  const GRUPO = "99999999-8888-4777-8666-555555555555";
  return {
    async atribuidosAoApp(appId) {
      expect(appId).toBe(APP);
      if (estado.appFalha) throw new GraphError("Graph respondeu 403 (Authorization_RequestDenied)", 403, "Authorization_RequestDenied");
      return [...estado.diretas.map((x) => ({ tipo: "usuario" as const, id: x.id })), { tipo: "grupo" as const, id: GRUPO }];
    },
    async usuarioEntra(id) {
      return estado.diretas.find((x) => x.id === id) ?? null;
    },
    async pessoasDoGrupo() {
      if (estado.grupoFalha) throw new GraphError("Graph respondeu 403", 403, "Authorization_RequestDenied");
      return estado.grupo;
    },
  };
}

describe.skipIf(!available)("pessoas pelo Entra", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const db = () => createWorkerDb(worker);
  const pessoa = async (e: string) =>
    (await owner.query("SELECT id, entra_oid, display_name, active, inativo_por, entra_atribuido FROM people WHERE email = $1", [e])).rows[0];

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    // Pessoas de outras rodadas deste teste não interferem.
    await owner.query("UPDATE people SET entra_atribuido = NULL WHERE entra_atribuido IS NOT NULL");
  });
  afterAll(async () => {
    await owner.query("UPDATE people SET entra_atribuido = NULL WHERE email LIKE $1", [`%-${tag}@filtrovali.com.br`]);
    await owner?.end();
    await worker?.end();
  });

  it("cria e liga quem está no app; desativa quem sai e reativa quem volta; respeita a Administração e a última pessoa administradora", async () => {
    // Já cadastrada (primeiro administrador), ainda sem conta Microsoft ligada; e outra administradora.
    const ana = u("ana");
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, 'Ana (manual)') RETURNING id", [ana.email]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'admin'), ($1, 'diretoria')", [rows[0]!.id]);
    const bia = u("bia");
    const enzo = u("enzo");
    const convidado = u("convidado", { convidada: true });
    const desligado = u("desligado", { ativa: false });
    const estado = { diretas: [ana, bia], grupo: [enzo, convidado, desligado] };

    const r1 = await sincronizarPessoasDoEntra(db(), fonte(estado), APP);
    expect(r1).toMatchObject({ atribuicoes: 3, pessoas: 3, criadas: 2, atualizadas: 1, ignoradas: 2, desativadas: 0, parcial: false, erro: null });
    expect(await pessoa(ana.email)).toMatchObject({ entra_oid: ana.id, display_name: "ana", active: true, entra_atribuido: true });
    expect((await owner.query("SELECT count(*)::int n FROM person_profiles WHERE person_id = $1", [rows[0]!.id])).rows[0].n).toBe(2);
    expect(await pessoa(convidado.email)).toBeUndefined();

    // Enzo sai do grupo: desativado e sem sessão.
    const c = await pessoa(enzo.email);
    await owner.query("INSERT INTO sessions (token_hash, person_id, expires_at) VALUES (sha256(random()::text::bytea), $1, now() + interval '1 day')", [c.id]);
    estado.grupo = [convidado, desligado];
    expect((await sincronizarPessoasDoEntra(db(), fonte(estado), APP)).desativadas).toBe(1);
    expect(await pessoa(enzo.email)).toMatchObject({ active: false, inativo_por: "entra", entra_atribuido: false });
    expect((await owner.query("SELECT count(*)::int n FROM sessions WHERE person_id = $1", [c.id])).rows[0].n).toBe(0);

    // A Administração reativa o Enzo mesmo fora do app: o Entra não desativa de novo a cada rodada.
    await owner.query("UPDATE people SET active = true, inativo_por = NULL WHERE id = $1", [c.id]);
    expect((await sincronizarPessoasDoEntra(db(), fonte(estado), APP)).desativadas).toBe(0);
    expect((await pessoa(enzo.email)).active).toBe(true);

    // Bia sai e volta: reativada sozinha.
    estado.diretas = [ana];
    expect((await sincronizarPessoasDoEntra(db(), fonte(estado), APP)).desativadas).toBe(1);
    estado.diretas = [ana, bia];
    expect((await sincronizarPessoasDoEntra(db(), fonte(estado), APP)).reativadas).toBe(1);
    expect(await pessoa(bia.email)).toMatchObject({ active: true, inativo_por: null });

    // Desativada pela Administração: o Entra não reativa.
    await owner.query("UPDATE people SET active = false, inativo_por = 'admin' WHERE email = $1", [bia.email]);
    await sincronizarPessoasDoEntra(db(), fonte(estado), APP);
    expect(await pessoa(bia.email)).toMatchObject({ active: false, inativo_por: "admin" });

    // Grupo ilegível (ex.: sem GroupMember.Read.All): ninguém é desativado nesta rodada.
    estado.diretas = [bia];
    const parcial = await sincronizarPessoasDoEntra(db(), fonte({ ...estado, grupoFalha: true }), APP);
    expect(parcial).toMatchObject({ parcial: true, desativadas: 0 });
    expect((await pessoa(ana.email)).active).toBe(true);

    // Ana sai do app, mas é a única administradora ativa: fica ativa (a Administração decide).
    await owner.query("UPDATE people p SET active = false, inativo_por = 'admin' FROM person_profiles pp WHERE pp.person_id = p.id AND pp.profile = 'admin' AND p.id <> $1 AND p.active", [rows[0]!.id]);
    await sincronizarPessoasDoEntra(db(), fonte(estado), APP);
    expect(await pessoa(ana.email)).toMatchObject({ active: true, entra_atribuido: false });

    // Sem permissão para ler o app: só o erro, nada muda.
    const semPermissao = await sincronizarPessoasDoEntra(db(), fonte({ ...estado, appFalha: true }), APP);
    expect(semPermissao).toMatchObject({ erro: expect.stringContaining("403"), pessoas: 0, desativadas: 0 });
  });

  it("e-mail já ligado a outra conta Microsoft: conflito, sem trocar a conta", async () => {
    const dono = randomUUID();
    const e = email("duplicado");
    await owner.query("INSERT INTO people (email, display_name, entra_oid) VALUES ($1, 'Original', $2)", [e, dono]);
    const outro = u("duplicado");
    const r = await sincronizarPessoasDoEntra(db(), fonte({ diretas: [outro], grupo: [] }), APP);
    expect(r.conflitos).toBe(1);
    expect(await pessoa(e)).toMatchObject({ entra_oid: dono, display_name: "Original" });
  });
});
