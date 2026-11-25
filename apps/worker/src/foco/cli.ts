import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { GraphClient } from "@omni/integrations/graph";
import pg from "pg";
import { z } from "zod";

import { loadWorkerEnv } from "../env.ts";
import { fonteExportacao, fonteSupabase } from "./fonte.ts";
import { importarFoco, relatorioEmTexto } from "./importar.ts";

/**
 * Migração do Foco para o Omni (Fase 3): `npm run foco:importar -- [opções]`.
 *
 *   (sem opções)                 ensaio: lê o Foco, grava numa transação e desfaz; mostra o relatório
 *   --real                       grava de verdade (staging ou produção; em desenvolvimento, só com --permitir-dev)
 *   --pular-chave "Chave codex"  chave de API que não migra (repetível)
 *   --conversa "OKR - Bimestral" conversa de projeto que vira uma tarefa com os comentários (repetível)
 *   --relatorio arquivo.md       grava o relatório no arquivo (contém e-mails: não versionar)
 *   --conferir-link <url .ics>   só confere qual chave assina um link de agenda do Foco (não carrega nada)
 *
 * Com FOCO_CHAVE_API_TESTE (uma chave `foco_live_…`), o relatório diz se ela continua valendo.
 *
 * Leitura do Foco (só leitura: nada é escrito nele), de um destes jeitos:
 *   - FOCO_SUPABASE_URL + FOCO_SUPABASE_SERVICE_ROLE_KEY (chave de serviço do Supabase); ou
 *   - FOCO_SUPABASE_URL + FOCO_SUPABASE_CHAVE_PUBLICA + FOCO_EXPORT_TOKEN, pela função de
 *     exportação (docs/integracoes/foco-exportacao.sql; Lovable Cloud, sem chave de serviço),
 *     com os anexos do pacote do desenvolvedor em FOCO_ANEXOS_PASTA.
 * E DATABASE_URL_OWNER. Anexos no modo real: Graph e GRAPH_ANEXOS_DRIVE_ID.
 */

const { values: a } = parseArgs({
  options: {
    real: { type: "boolean", default: false },
    "permitir-dev": { type: "boolean", default: false },
    "pular-chave": { type: "string", multiple: true, default: [] },
    conversa: { type: "string", multiple: true, default: [] },
    relatorio: { type: "string" },
    "conferir-link": { type: "string" },
  },
});

const foco = z
  .object({
    FOCO_SUPABASE_URL: z.url({ protocol: /^https$/ }),
    FOCO_SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional().or(z.literal("").transform(() => undefined)),
    FOCO_SUPABASE_CHAVE_PUBLICA: z.string().min(20).optional().or(z.literal("").transform(() => undefined)),
    FOCO_EXPORT_TOKEN: z.string().min(32).optional().or(z.literal("").transform(() => undefined)),
    FOCO_ANEXOS_PASTA: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
    DATABASE_URL_OWNER: z.url({ protocol: /^postgres(ql)?$/ }),
  })
  .refine((v) => Boolean(v.FOCO_EXPORT_TOKEN && v.FOCO_SUPABASE_CHAVE_PUBLICA) || Boolean(v.FOCO_SUPABASE_SERVICE_ROLE_KEY), {
    path: ["FOCO_EXPORT_TOKEN"],
    message: "defina FOCO_EXPORT_TOKEN + FOCO_SUPABASE_CHAVE_PUBLICA ou FOCO_SUPABASE_SERVICE_ROLE_KEY",
  })
  .safeParse(process.env);
if (!foco.success) {
  console.error(`Faltam variáveis: ${foco.error.issues.map((i) => i.path.join(".")).join(", ")} (os valores não são mostrados).`);
  process.exit(1);
}
const env = loadWorkerEnv();
const ambiente = env.OMNI_AMBIENTE ?? (env.NODE_ENV === "production" ? "producao" : "desenvolvimento");
if (a.real && ambiente === "desenvolvimento" && !a["permitir-dev"]) {
  console.error("Carga real em desenvolvimento copiaria os dados reais do Foco para esta máquina. Rode o ensaio, ou a carga real no staging/produção (ou use --permitir-dev).");
  process.exit(1);
}

const graph =
  env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_PRIVATE_KEY_PATH && env.GRAPH_CERT_SHA256_THUMBPRINT
    ? new GraphClient({ tenantId: env.GRAPH_TENANT_ID, clientId: env.GRAPH_CLIENT_ID, privateKeyPem: readFileSync(env.GRAPH_PRIVATE_KEY_PATH, "utf8"), thumbprintSha256: env.GRAPH_CERT_SHA256_THUMBPRINT })
    : null;

const pelaExportacao = Boolean(foco.data.FOCO_EXPORT_TOKEN && foco.data.FOCO_SUPABASE_CHAVE_PUBLICA);
const fonte = pelaExportacao
  ? fonteExportacao(foco.data.FOCO_SUPABASE_URL, foco.data.FOCO_SUPABASE_CHAVE_PUBLICA!, foco.data.FOCO_EXPORT_TOKEN!, foco.data.FOCO_ANEXOS_PASTA ?? null)
  : fonteSupabase(foco.data.FOCO_SUPABASE_URL, foco.data.FOCO_SUPABASE_SERVICE_ROLE_KEY!);

// Qual chave assina os links de agenda do Foco: a APPLE_CALENDAR_SIGNING_KEY ou, sem ela, a de serviço do Supabase.
if (a["conferir-link"]) {
  const m = a["conferir-link"].match(/feed\/([0-9a-f-]{36})\.([0-9a-f]{64})\.ics/i);
  if (!m) {
    console.error("Link inválido: esperado …/api/calendar/apple/feed/<id>.<assinatura>.ics");
    process.exit(1);
  }
  const feed = (await fonte.tabela("apple_calendar_feeds"))?.find((f) => f.id === m[1]);
  if (!feed) {
    console.error("Esse link não está entre os feeds do Foco.");
    process.exit(1);
  }
  const assina = (chave: string | undefined) => (chave ? createHmac("sha256", chave).update(`${String(feed.id)}:${String(feed.user_id)}:${String(feed.created_at)}`).digest("hex") === m[2]!.toLowerCase() : false);
  if (assina(process.env.APPLE_CALENDAR_SIGNING_KEY)) console.log("✅ O link é assinado pela APPLE_CALENDAR_SIGNING_KEY configurada aqui: os links do Foco continuam valendo no Omni.");
  else if (assina(foco.data.FOCO_SUPABASE_SERVICE_ROLE_KEY)) console.log("⚠️ O link é assinado pela SUPABASE_SERVICE_ROLE_KEY do Foco: use esse valor como APPLE_CALENDAR_SIGNING_KEY no Omni.");
  else console.log("❌ Nenhuma chave configurada aqui assina esse link. Se o Foco assina com a chave de serviço do Lovable (que não fica disponível), os links antigos não continuam: quem usa assina o link novo do Omni (Notificações e app → Agenda).");
  process.exit(0);
}

const owner = new pg.Pool({ connectionString: foco.data.DATABASE_URL_OWNER, max: 2 });
try {
  console.log(`Migração do Foco — ${a.real ? "CARGA REAL" : "ensaio"} (${ambiente}; leitura ${pelaExportacao ? "pela função de exportação" : "pela chave de serviço"})`);
  const r = await importarFoco(owner, fonte, {
    real: a.real,
    enviarArquivo: graph ? (d, c, b) => graph.enviarArquivo(d, c, b) : null,
    driveId: env.GRAPH_ANEXOS_DRIVE_ID ?? null,
    pastaAnexos: ambiente === "producao" ? "Tarefas" : `Tarefas-${ambiente}`,
    pularChaves: a["pular-chave"],
    conversas: a.conversa,
    conferirToken: process.env.FOCO_CHAVE_API_TESTE || null,
    log: (m) => console.log(m),
  });
  const texto = relatorioEmTexto(r);
  if (a.relatorio) {
    writeFileSync(a.relatorio, texto, { mode: 0o600 });
    console.log(`\nRelatório em ${a.relatorio}`);
  } else console.log(`\n${texto}`);
  const diferente = Object.values(r.conferencia).some((c) => c.esperado !== c.noOmni) || r.anexos.falharam.length > 0;
  process.exitCode = diferente ? 2 : 0;
} catch (error) {
  console.error("A migração parou:", error instanceof Error ? error.message : "erro");
  process.exitCode = 1;
} finally {
  await owner.end();
}
