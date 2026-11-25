import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/**
 * 0072: as regras de acesso em forma de conjunto (calculadas uma vez por consulta) dão
 * exatamente o mesmo resultado das funções por linha que continuam existindo:
 * app.missoes_que_vejo ≡ app.ve_missao, app.internos_que_vejo ≡ app.ve_interno,
 * app.conversas_que_vejo ≡ app.ve_conversa_whatsapp, app.novidades_dos_canais ≡ contagem
 * pela política dos canais — para cada tipo de vínculo com a missão.
 */
const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
};
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

describe.skipIf(!available)("regras de acesso em conjunto (0072)", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const p: Record<string, string> = {};
  const m: string[] = [];
  const chats: string[] = [];

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    const q = (t: string, v: unknown[] = []) => owner.query(t, v);
    const pessoa = async (k: string, perfil: string, extra: { colaborador?: string } = {}) => {
      const id = (
        await q("INSERT INTO people (email, display_name, filtroapp_collaborator_id) VALUES ($1, $2, $3) RETURNING id", [`${k}-${tag}@desempenho.invalid`, k, extra.colaborador ?? null])
      ).rows[0].id as string;
      await q("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      p[k] = id;
    };
    await pessoa("diretoria", "diretoria");
    await pessoa("gerente", "gerente");
    await pessoa("membro", "operacao");
    await pessoa("membroGerencial", "operacao");
    await pessoa("responsavel", "lider_projetos");
    await pessoa("alocado", "operacao", { colaborador: `col-${tag}` });
    await pessoa("liberado", "vendas");
    await pessoa("funcao", "operacao");
    await pessoa("fora", "operacao");
    const livres = (
      await q(`SELECT lpad(c::text, 4, '0') AS c FROM generate_series(4000, 4999) c WHERE NOT EXISTS (SELECT 1 FROM missions WHERE code = lpad(c::text, 4, '0')) LIMIT 7`)
    ).rows.map((r) => r.c as string);
    for (const [i, code] of livres.entries()) {
      m.push((await q("INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ($1, $2, 'Cliente', $3, now()) RETURNING id", [code, `desemp-${tag}-${code}`, i !== 6])).rows[0].id);
    }
    // m0: membro do Interno; m1: responsável (líder); m2: equipe alocada; m3: liberada à mão;
    // m4: função da IA; m5: membro só do Gerencial; m6: inativa com membro.
    await q("INSERT INTO mission_members (mission_id, channel, person_id, added_by) VALUES ($1, 'interno', $2, $2), ($3, 'gerencial', $4, $4), ($5, 'interno', $2, $2)", [m[0], p.membro, m[5], p.membroGerencial, m[6]]);
    await q("INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES ($1, 'LEADER', 'Líder', $2, now())", [m[1], `responsavel-${tag}@desempenho.invalid`]);
    await q("INSERT INTO mission_allocations (id, mission_id, collaborator_id, filtroapp_updated_at) VALUES ($1, $2, $3, now())", [`aloc-${tag}`, m[2], `col-${tag}`]);
    await q("INSERT INTO mission_viewers (mission_id, person_id, added_by) VALUES ($1, $2, $3)", [m[3], p.liberado, p.diretoria]);
    await q("INSERT INTO mission_function_access (mission_id, function_code, reason) VALUES ($1, 'documentacao', 'teste') ON CONFLICT DO NOTHING", [m[4]]);
    await q("INSERT INTO function_assignments (function_code, person_id) VALUES ('documentacao', $1)", [p.funcao]);
    // WhatsApp: o número do membro (uma conversa) e outro número com um grupo ligado à m0.
    const n1 = (await q("INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, status) VALUES ($1, 'Membro', 'outro', $2, 'conectado') RETURNING id", [`omni-desemp${tag}a`, p.membro])).rows[0].id;
    const n2 = (await q("INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, status) VALUES ($1, 'Outro', 'outro', $2, 'conectado') RETURNING id", [`omni-desemp${tag}b`, p.fora])).rows[0].id;
    chats.push((await q("INSERT INTO whatsapp_chats (number_id, jid, is_group, phone) VALUES ($1, '5547911110001@s.whatsapp.net', false, '5547911110001') RETURNING id", [n1])).rows[0].id);
    chats.push((await q("INSERT INTO whatsapp_chats (number_id, jid, is_group) VALUES ($1, '120363000000000099@g.us', true) RETURNING id", [n2])).rows[0].id);
    await q("INSERT INTO whatsapp_chat_missions (chat_id, mission_id) VALUES ($1, $2)", [chats[1], m[0]]);
    // Mensagens nos canais: de pessoas, da IA e da própria pessoa; uma leitura no meio.
    for (const missao of m) {
      await q(
        `INSERT INTO mission_messages (mission_id, channel, author_person_id, kind, body, created_at)
         SELECT $1, CASE WHEN g % 3 = 0 THEN 'gerencial' ELSE 'interno' END,
                CASE WHEN g % 4 = 0 THEN NULL WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
                CASE WHEN g % 4 = 0 THEN 'sistema' ELSE 'texto' END, 'msg ' || g, now() - make_interval(mins => 100 - g)
           FROM generate_series(1, 12) g`,
        [missao, p.membro, p.responsavel],
      );
    }
    await q("INSERT INTO mission_reads (mission_id, channel, person_id, last_read_at) VALUES ($1, 'interno', $2, now() - interval '93 minutes')", [m[0], p.membro]);
  });

  afterAll(async () => {
    await owner?.query("DELETE FROM missions WHERE filtroapp_project_id LIKE $1", [`desemp-${tag}-%`]);
    await owner?.query("DELETE FROM whatsapp_numbers WHERE instance_name LIKE $1", [`omni-desemp${tag}%`]);
    await owner?.query("DELETE FROM function_assignments WHERE person_id = $1", [p.funcao]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  /** As duas formas, calculadas como a pessoa (sem o RLS do papel da tela, para comparar só as regras). */
  async function comparar(quem: string) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.person_id', $1, true)", [quem]);
      const lista = async (t: string, v: unknown[] = []) => (await c.query(t, v)).rows.map((r) => Object.values(r)[0] as string).filter((x) => m.includes(x) || chats.includes(x)).sort();
      const r = {
        missoes: [await lista("SELECT id FROM missions WHERE id = ANY($1::uuid[]) AND app.ve_missao(id)", [m]), await lista("SELECT x FROM app.missoes_que_vejo() x")],
        internos: [
          await lista("SELECT id FROM missions WHERE id = ANY($1::uuid[]) AND app.ve_interno(id, $2::uuid)", [m, quem]),
          await lista("SELECT x FROM app.internos_que_vejo() x"),
        ],
        conversas: [await lista("SELECT id FROM whatsapp_chats WHERE id = ANY($1::uuid[]) AND app.ve_conversa_whatsapp(id)", [chats]), await lista("SELECT x FROM app.conversas_que_vejo() x")],
      };
      await c.query("COMMIT");
      return r;
    } finally {
      c.release();
    }
  }

  it("missões, Interno e conversas: o conjunto é igual à regra por linha para cada tipo de vínculo", { timeout: 60_000 }, async () => {
    const vistas: Record<string, number> = {};
    for (const [k, id] of Object.entries(p)) {
      const r = await comparar(id);
      expect(r.missoes[1], `missões de ${k}`).toEqual(r.missoes[0]);
      expect(r.internos[1], `Interno de ${k}`).toEqual(r.internos[0]);
      expect(r.conversas[1], `conversas de ${k}`).toEqual(r.conversas[0]);
      vistas[k] = r.missoes[0]!.length;
    }
    // E o caso não é trivial: cada vínculo vê o que deve.
    expect(vistas).toMatchObject({ diretoria: 7, gerente: 7, membro: 2, membroGerencial: 1, responsavel: 1, alocado: 1, liberado: 1, funcao: 1, fora: 0 });
  });

  it("as políticas novas mostram as mesmas missões e conversas pelo papel da tela", async () => {
    const pela = (quem: string, t: ReturnType<typeof sql>) =>
      withPerson(app, quem, (db) => db.execute<{ id: string }>(t)).then((r) => r.rows.map((x) => x.id).filter((x) => m.includes(x) || chats.includes(x)).sort());
    expect(await pela(p.membro!, sql`SELECT id FROM missions`)).toEqual([m[0], m[6]].sort());
    expect(await pela(p.membro!, sql`SELECT id FROM whatsapp_chats`)).toEqual([...chats].sort()); // o seu e o grupo da missão
    expect(await pela(p.fora!, sql`SELECT id FROM whatsapp_chats`)).toEqual([chats[1]]); // o grupo do seu número
    expect(await pela(p.fora!, sql`SELECT id FROM missions`)).toEqual([]);
  });

  it("mensagens novas dos canais: a função dá a mesma contagem que a política dos canais (missões ativas)", { timeout: 60_000 }, async () => {
    for (const quem of [p.membro!, p.diretoria!, p.responsavel!, p.membroGerencial!, p.fora!]) {
      const antiga = await withPerson(app, quem, (db) =>
        db.execute<{ mission_id: string; channel: string; n: number }>(sql`
          SELECT m.mission_id, m.channel, count(*)::int AS n
            FROM mission_messages m
            JOIN missions mi ON mi.id = m.mission_id AND mi.is_active
            LEFT JOIN mission_reads r ON r.mission_id = m.mission_id AND r.channel = m.channel AND r.person_id = app.current_person_id()
           WHERE m.created_at > coalesce(r.last_read_at, '-infinity') AND m.author_person_id IS DISTINCT FROM app.current_person_id()
           GROUP BY 1, 2`),
      );
      const nova = await withPerson(app, quem, (db) =>
        db.execute<{ mission_id: string; channel: string; n: number }>(sql`SELECT mission_id, channel, (de_pessoas + da_ia)::int AS n FROM app.novidades_dos_canais()`),
      );
      const chave = (rows: { mission_id: string; channel: string; n: number }[]) =>
        rows.filter((r) => m.includes(r.mission_id)).map((r) => `${r.mission_id}:${r.channel}:${r.n}`).sort();
      expect(chave(nova.rows)).toEqual(chave(antiga.rows));
    }
  });
});
