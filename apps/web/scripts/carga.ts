/**
 * Teste de carga do Omni (Fase 11): as consultas mais pesadas da tela, com volume de
 * empresa inteira e várias pessoas ao mesmo tempo, sempre pelo papel da tela (omni_app,
 * com RLS) — como o servidor faz.
 *
 *   npm run carga                       (banco de teste omni_test; cria e apaga os dados)
 *   CARGA_PESSOAS=40 CARGA_RODADAS=20 npm run carga
 *
 * Volume (por pessoa "de escritório", o caso pesado): 50 mil cabeçalhos de e-mail com
 * 2 mil correspondentes, 2 mil conversas de WhatsApp com 200 mil mensagens; 200 missões
 * com 40 mil mensagens nos canais. Falha (código 1) se o p95 de alguma consulta passar
 * do limite. Nada sai do banco de teste; os dados são fictícios (@carga.invalid).
 */
import { randomUUID } from "node:crypto";

import { createPool, migrate, schema, withPerson, type Db } from "@omni/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import pg from "pg";

import { lerCorrespondentes } from "../src/server/correspondentes.ts";
import { lerNovidadesDasMissoes } from "../src/server/novidades.ts";

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
};
const PESSOAS = Number(process.env.CARGA_PESSOAS ?? 20);
const RODADAS = Number(process.env.CARGA_RODADAS ?? 10);
const LIMITE_P95_MS = Number(process.env.CARGA_LIMITE_P95_MS ?? 500);
/** CARGA_MANTER=1: deixa os dados fictícios no banco de teste (para EXPLAIN); apague depois com CARGA_LIMPAR=<tag>. */
const MANTER = process.env.CARGA_MANTER === "1";
const tag = randomUUID().slice(0, 8);

const owner = createPool(urls.owner, 4);
const app = createPool(urls.app, Math.min(PESSOAS, 30));

async function semear() {
  const t0 = Date.now();
  const q = async (texto: string, valores: unknown[] = []) => {
    const t = Date.now();
    const r = await owner.query(texto, valores);
    if (process.env.CARGA_DETALHE && Date.now() - t > 1000) console.log(`  ${((Date.now() - t) / 1000).toFixed(1)} s · ${texto.trim().split("\n")[0]!.slice(0, 70)}`);
    return r;
  };
  const pessoa = async (nome: string, perfil: string) => {
    const id = (await q("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@carga.invalid`, nome])).rows[0].id as string;
    await q("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
    return id;
  };
  const gerente = await pessoa("gerente", "gerente");
  const operacao = await pessoa("operacao", "operacao");
  const email = `gerente-${tag}@carga.invalid`;
  const caixa = (await q("INSERT INTO mail_mailboxes (email, active) VALUES ($1, false) RETURNING id", [email])).rows[0].id as string;
  // E-mails: 50 mil (70% recebidos), 2 mil correspondentes, últimos 120 dias.
  await q(
    `INSERT INTO mail_items (mailbox_id, owner_person_id, graph_id, folder, from_name, from_address, to_recipients, addresses, subject, preview, received_at, sent_at, is_read)
     SELECT $1, $2, 'CARGA-' || g, CASE WHEN g % 10 < 7 THEN 'inbox' ELSE 'sentitems' END,
            'Contato ' || (g % 2000), CASE WHEN g % 10 < 7 THEN 'c' || (g % 2000) || '@cliente' || (g % 300) || '.exemplo' ELSE $3 END,
            CASE WHEN g % 10 < 7 THEN jsonb_build_array(jsonb_build_object('nome', 'Gerente', 'endereco', $3::text))
                 ELSE jsonb_build_array(jsonb_build_object('nome', 'Contato ' || (g % 2000), 'endereco', 'c' || (g % 2000) || '@cliente' || (g % 300) || '.exemplo')) END,
            ARRAY['c' || (g % 2000) || '@cliente' || (g % 300) || '.exemplo', $3::text],
            'Assunto do e-mail ' || g, repeat('Prévia do e-mail. ', 10), now() - make_interval(mins => (g * 3) % (120 * 24 * 60)), now() - make_interval(mins => (g * 3) % (120 * 24 * 60)), g % 13 <> 0
       FROM generate_series(1, 50000) g`,
    [caixa, gerente, email],
  );
  // WhatsApp: 1 número, 2 mil conversas, 200 mil mensagens.
  const numero = (await q("INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, phone, status) VALUES ($1, 'Carga', 'outro', $2, $3, 'conectado') RETURNING id", [`omni-carga${tag}`, gerente, `5547${Math.floor(1e8 + Math.random() * 8e8)}`])).rows[0].id as string;
  await q(
    `INSERT INTO whatsapp_chats (number_id, jid, is_group, phone, name, last_message_at, last_preview)
     SELECT $1, (5547900000000 + g)::text || '@s.whatsapp.net', false, (5547900000000 + g)::text, 'Contato ' || g, now() - make_interval(mins => g * 7), 'última mensagem'
       FROM generate_series(1, 2000) g`,
    [numero],
  );
  await q(
    `INSERT INTO whatsapp_messages (chat_id, wa_id, from_me, kind, body, sent_at, created_at)
     SELECT c.id, 'CARGA' || g, g % 3 = 0, 'texto', 'Mensagem ' || g, now() - make_interval(mins => g), now() - make_interval(mins => g)
       FROM whatsapp_chats c, generate_series(1, 100) g WHERE c.number_id = $1`,
    [numero],
  );
  // Missões: 200 (números livres), 40 mil mensagens nos canais (pessoas e IA); a operação participa de 20.
  const codigos = (
    await q(`SELECT lpad(c::text, 4, '0') AS c FROM generate_series(2000, 3999) c WHERE NOT EXISTS (SELECT 1 FROM missions WHERE code = lpad(c::text, 4, '0')) LIMIT 200`)
  ).rows.map((r) => r.c as string);
  const missoes = (
    await q(
      `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at)
       SELECT c, 'carga-' || $1 || '-' || c, 'Cliente ' || c, true, now() FROM unnest($2::text[]) c RETURNING id`,
      [tag, codigos],
    )
  ).rows.map((r) => r.id as string);
  await q(
    `INSERT INTO mission_messages (mission_id, channel, author_person_id, kind, body, created_at)
     SELECT m, CASE WHEN g % 4 = 0 THEN 'gerencial' ELSE 'interno' END,
            CASE WHEN g % 5 = 0 THEN NULL WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
            CASE WHEN g % 5 = 0 THEN 'sistema' ELSE 'texto' END, 'Mensagem do canal ' || g, now() - make_interval(mins => g * 11)
       FROM unnest($1::uuid[]) m, generate_series(1, 200) g`,
    [missoes, gerente, operacao],
  );
  await q(
    `INSERT INTO mission_members (mission_id, channel, person_id, added_by) SELECT m, 'interno', $2, $2 FROM unnest($1::uuid[]) m`,
    [missoes.slice(0, 20), operacao],
  );
  await q("ANALYZE mail_items; ANALYZE whatsapp_chats; ANALYZE whatsapp_messages; ANALYZE mission_messages; ANALYZE missions");
  console.log(`Dados fictícios criados em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { gerente, operacao, numero, caixa, missoes };
}

async function limpar(t = tag) {
  await owner.query("DELETE FROM missions WHERE filtroapp_project_id LIKE $1", [`carga-${t}-%`]);
  await owner.query("DELETE FROM whatsapp_numbers WHERE instance_name = $1", [`omni-carga${t}`]);
  await owner.query("DELETE FROM mail_mailboxes WHERE email = $1", [`gerente-${t}@carga.invalid`]);
  await owner.query("UPDATE people SET active = false WHERE email LIKE $1", [`%-${t}@carga.invalid`]);
}

type Cenario = { nome: string; quem: "gerente" | "operacao"; rodar: (db: Db) => Promise<unknown> };

function cenarios(chatId: string): Cenario[] {
  return [
    {
      nome: "Conversas do WhatsApp (até 2.000)",
      quem: "gerente",
      // Como listarConversas (conversas-fns.ts): a lista e, uma vez por número, responder/ligar.
      rodar: async (db) => {
        const linhas = await db
          .select({ c: schema.whatsappChats, numero: schema.whatsappNumbers.id })
          .from(schema.whatsappChats)
          .innerJoin(schema.whatsappNumbers, eq(schema.whatsappNumbers.id, schema.whatsappChats.numberId))
          .where(isNotNull(schema.whatsappChats.lastMessageAt))
          .orderBy(desc(schema.whatsappChats.lastMessageAt))
          .limit(2000);
        const numeros = [...new Set(linhas.map((l) => l.numero))];
        if (numeros.length) await db.execute(sql`SELECT app.ve_numero_whatsapp(id), app.pode_usar_linha_chamada(id) FROM unnest(${`{${numeros.join(",")}}`}::uuid[]) AS id`);
        return linhas;
      },
    },
    {
      nome: "Mensagens de uma conversa",
      quem: "gerente",
      rodar: (db) => db.select().from(schema.whatsappMessages).where(eq(schema.whatsappMessages.chatId, chatId)).orderBy(desc(schema.whatsappMessages.sentAt)).limit(200),
    },
    { nome: "Correspondentes de e-mail (caixa única)", quem: "gerente", rodar: (db) => lerCorrespondentes(db) },
    {
      nome: "E-mails de um contato",
      quem: "gerente",
      rodar: (db) =>
        db
          .select()
          .from(schema.mailItems)
          .where(sql`${schema.mailItems.addresses} && ${"{c7@cliente7.exemplo}"}::text[]`)
          .orderBy(sql`coalesce(${schema.mailItems.receivedAt}, ${schema.mailItems.sentAt}) DESC`)
          .limit(200),
    },
    { nome: "Missões com novidade (gerente)", quem: "gerente", rodar: (db) => lerNovidadesDasMissoes(db) },
    { nome: "Missões com novidade (operação)", quem: "operacao", rodar: (db) => lerNovidadesDasMissoes(db) },
    { nome: "Lista de missões (operação, RLS)", quem: "operacao", rodar: (db) => db.select().from(schema.missions).where(and(eq(schema.missions.isActive, true))) },
  ];
}

const p = (xs: number[], q: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;

async function main() {
  await migrate(urls.owner);
  if (process.env.CARGA_LIMPAR) {
    await limpar(process.env.CARGA_LIMPAR);
    await Promise.all([owner.end(), app.end()]);
    console.log("Dados fictícios apagados.");
    return;
  }
  const dados = await semear();
  let falhou = false;
  try {
    const chat = (await owner.query("SELECT id FROM whatsapp_chats WHERE number_id = $1 ORDER BY last_message_at DESC LIMIT 1", [dados.numero])).rows[0].id as string;
    console.log(`\n${PESSOAS} pessoas ao mesmo tempo × ${RODADAS} rodadas · limite p95 ${LIMITE_P95_MS} ms\n`);
    console.log(`${"Consulta".padEnd(42)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"máx".padStart(7)}  linhas`);
    for (const c of cenarios(chat)) {
      const tempos: number[] = [];
      let linhas = 0;
      const pessoaId = c.quem === "gerente" ? dados.gerente : dados.operacao;
      await Promise.all(
        Array.from({ length: PESSOAS }, async () => {
          for (let i = 0; i < RODADAS; i++) {
            const t = performance.now();
            const r = await withPerson(app, pessoaId, (db) => c.rodar(db));
            tempos.push(performance.now() - t);
            linhas = Array.isArray(r) ? r.length : linhas;
          }
        }),
      );
      const p95 = p(tempos, 0.95);
      const ruim = p95 > LIMITE_P95_MS;
      falhou ||= ruim;
      console.log(`${(ruim ? "✗ " : "✓ ") + c.nome.padEnd(40)} ${p(tempos, 0.5).toFixed(0).padStart(5)}ms ${p95.toFixed(0).padStart(5)}ms ${Math.max(...tempos).toFixed(0).padStart(5)}ms  ${linhas}`);
    }
  } finally {
    if (MANTER) console.log(`\nDados mantidos (tag ${tag}; gerente ${dados.gerente}, operação ${dados.operacao}). Apague com: CARGA_LIMPAR=${tag} npm run carga`);
    else await limpar();
    await Promise.all([owner.end(), app.end()]);
  }
  console.log(falhou ? "\nAlguma consulta passou do limite." : "\nTodas as consultas dentro do limite.");
  process.exitCode = falhou ? 1 : 0;
}

await main();
