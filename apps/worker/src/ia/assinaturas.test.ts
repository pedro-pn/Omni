import { createPool, createWorkerDb, migrate } from "@omni/db";
import type { Llm } from "@omni/integrations/openai";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lerAssinaturas } from "./assinaturas.ts";

/** Assinaturas dos participantes, no banco real (omni_test). Missão 7602 e endereços @assinatura-teste.invalid são deste arquivo. */

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

const CORPOS: Record<string, string> = {
  "g-joao": "Bom dia.\nSegue o cronograma.\n\nAtenciosamente,\nJoão Silva\nCoordenador de Manutenção\nPorto Norte S.A.\n(47) 3333-4444\n\nDe: Ana <ana@filtrovali.com.br>\nAssunto: x",
  "g-curto": "ok",
  // Caixa pessoal (0076): telefone citado no corpo vira sugestão; o da conversa citada, não.
  "g-maria":
    "Oi! Pode me ligar no (47) 99123-4567 amanhã cedo? O pedido é o 4799123456.\n\nAtt,\nMaria Souza\nCompras\n\nEm seg., 24 nov. 2026 escreveu:\n> Ligue no (11) 98888-7777",
};

describe.skipIf(!available)("assinaturas dos participantes", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const lidos: string[] = [];
  const entradas: string[] = [];
  const llm: Llm = {
    async estruturado<T>(p: { entrada: string }) {
      entradas.push(p.entrada);
      // Inventa o cargo "Diretor" (não está no texto): deve ser descartado.
      const dados = { nome: "João Silva", cargo: p.entrada.includes("Coordenador") ? "Coordenador de Manutenção" : "Diretor", empresa: "Porto Norte S.A.", telefone: "(47) 3333-4444" };
      return { dados: dados as T, modelo: "modelo-teste", tokensEntrada: 50, tokensSaida: 20, duracaoMs: 10 };
    },
  };
  const ler = async (_caixa: string, id: string) => {
    lidos.push(id);
    return CORPOS[id] ?? null;
  };

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    await owner.query("DELETE FROM email_signature_extractions WHERE address LIKE '%@assinatura-teste.invalid'");
    await owner.query("DELETE FROM mail_message_copies WHERE message_id IN (SELECT id FROM mail_messages WHERE internet_message_id LIKE '<assinatura-teste-%')");
    await owner.query("DELETE FROM mail_message_missions WHERE message_id IN (SELECT id FROM mail_messages WHERE internet_message_id LIKE '<assinatura-teste-%')");
    await owner.query("DELETE FROM mail_messages WHERE internet_message_id LIKE '<assinatura-teste-%'");
    await owner.query("DELETE FROM mail_mailboxes WHERE email = 'caixa@assinatura-teste.invalid'");
    await owner.query("DELETE FROM missions WHERE code = '7602'");
    // Outros remetentes do banco compartilhado não entram nesta rodada.
    await owner.query(`INSERT INTO email_signature_extractions (address, status) SELECT DISTINCT lower(from_address), 'sem_assinatura' FROM mail_messages WHERE from_address LIKE '%@%' ON CONFLICT DO NOTHING`);
    await owner.query(`INSERT INTO email_signature_extractions (address, status) SELECT DISTINCT from_address, 'sem_assinatura' FROM mail_items WHERE from_address LIKE '%@%' ON CONFLICT DO NOTHING`);
    const missao = (await owner.query<{ id: string }>("INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('7602', 'assinatura-7602', 'Porto Norte', true, now()) RETURNING id")).rows[0]!.id;
    const caixa = (await owner.query<{ id: string }>("INSERT INTO mail_mailboxes (email) VALUES ('caixa@assinatura-teste.invalid') RETURNING id")).rows[0]!.id;
    for (const [n, de, graph] of [["1", "Joao@Assinatura-Teste.invalid", "g-joao"], ["2", "curto@assinatura-teste.invalid", "g-curto"], ["3", "no-reply@assinatura-teste.invalid", "g-auto"], ["4", "colega@filtrovali.com.br", "g-interno"]] as const) {
      const m = (await owner.query<{ id: string }>("INSERT INTO mail_messages (internet_message_id, from_address, from_name, received_at) VALUES ($1, $2, 'Remetente', now()) RETURNING id", [`<assinatura-teste-${n}>`, de])).rows[0]!.id;
      await owner.query("INSERT INTO mail_message_missions (message_id, mission_id, motivo, detalhe) VALUES ($1, $2, 'numero', '7602')", [m, missao]);
      await owner.query("INSERT INTO mail_message_copies (mailbox_id, graph_id, message_id, folder) VALUES ($1, $2, $3, 'inbox')", [caixa, graph, m]);
    }
  });
  const limpar = async () => {
    await owner.query("DELETE FROM email_signature_extractions WHERE address LIKE '%@assinatura-teste.invalid'");
    await owner.query("DELETE FROM mail_message_copies WHERE message_id IN (SELECT id FROM mail_messages WHERE internet_message_id LIKE '<assinatura-teste-%')");
    await owner.query("DELETE FROM mail_message_missions WHERE message_id IN (SELECT id FROM mail_messages WHERE internet_message_id LIKE '<assinatura-teste-%')");
    await owner.query("DELETE FROM mail_messages WHERE internet_message_id LIKE '<assinatura-teste-%'");
    await owner.query("DELETE FROM mail_mailboxes WHERE email = 'caixa@assinatura-teste.invalid'");
    await owner.query("DELETE FROM missions WHERE code = '7602'");
  };
  afterAll(async () => {
    // Não deixar a caixa fictícia no banco compartilhado (o teste dos e-mails conta as caixas).
    if (owner) await limpar();
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("lê só remetentes externos de e-mails de missão; confere cada campo no texto; não repete", async () => {
    const r = await lerAssinaturas(createWorkerDb(worker), ler, llm, { modelo: "modelo-teste" });
    expect(r).toMatchObject({ lidas: 2, ok: 1, semAssinatura: 1, erros: 0 });
    expect(lidos.sort()).toEqual(["g-curto", "g-joao"]); // nem automático nem colega da Filtrovali
    expect(entradas[0]).toContain("Coordenador de Manutenção");
    expect(entradas[0]).not.toContain("Assunto: x"); // a conversa citada não vai ao modelo
    const { rows } = await owner.query("SELECT address, nome, cargo, empresa, telefone, status FROM email_signature_extractions WHERE address LIKE '%@assinatura-teste.invalid' ORDER BY address");
    expect(rows).toEqual([
      { address: "curto@assinatura-teste.invalid", nome: null, cargo: null, empresa: null, telefone: null, status: "sem_assinatura" },
      { address: "joao@assinatura-teste.invalid", nome: "João Silva", cargo: "Coordenador de Manutenção", empresa: "Porto Norte S.A.", telefone: "(47) 3333-4444", status: "ok" },
    ]);
    expect((await lerAssinaturas(createWorkerDb(worker), ler, llm, { modelo: "modelo-teste" })).lidas).toBe(0);
  });

  it("caixa pessoal (0076): lê o remetente externo da Entrada e guarda os telefones citados no corpo (sem a conversa citada nem números corridos)", async () => {
    const dono = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('dono-' || gen_random_uuid() || '@assinatura-teste.invalid', 'Dono') RETURNING id")).rows[0]!.id;
    const caixa = (await owner.query<{ id: string }>("SELECT id FROM mail_mailboxes WHERE email = 'caixa@assinatura-teste.invalid'")).rows[0]!.id;
    await owner.query(
      `INSERT INTO mail_items (mailbox_id, owner_person_id, graph_id, folder, from_name, from_address, addresses, subject, received_at, is_read)
       VALUES ($1, $2, 'g-maria', 'inbox', 'Maria', 'maria@assinatura-teste.invalid', ARRAY['maria@assinatura-teste.invalid'], 'Pedido', now(), true)`,
      [caixa, dono],
    );
    try {
      await lerAssinaturas(createWorkerDb(worker), ler, llm, { modelo: "modelo-teste" });
      expect(lidos).toContain("g-maria");
      const dicas = (await owner.query("SELECT phone FROM contact_phone_hints WHERE address = 'maria@assinatura-teste.invalid'")).rows.map((x) => x.phone);
      expect(dicas).toEqual(["5547991234567"]);
    } finally {
      await owner.query("DELETE FROM contact_phone_hints WHERE address LIKE '%@assinatura-teste.invalid'");
      await owner.query("DELETE FROM mail_items WHERE graph_id = 'g-maria'");
      await owner.query("DELETE FROM people WHERE id = $1", [dono]);
    }
  });
});
