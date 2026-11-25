import { withPerson } from "@omni/db";
import { sql } from "drizzle-orm";
import pg from "pg";

import { getPool } from "./db.ts";
import { getEnv } from "./env.ts";

/**
 * Tempo real por SSE. Uma conexão dedicada faz LISTEN em:
 *   - `omni_mensagens` (migration 0005): só os assinantes que veem o canal
 *     (app.canal_desde, com a identidade deles) recebem o evento;
 *   - `omni_avisos` (migration 0011): só o destinatário do aviso recebe;
 *   - `omni_whatsapp` (migration 0027): só quem lê a conversa (app.ve_conversa_whatsapp, 0028);
 *   - `omni_chamadas` (rota /api/chamadas/eventos): só o dono da linha (chamada tocando, atendida, encerrada).
 * Os eventos levam só identificadores; o conteúdo é relido pela tela, com RLS.
 */

type Aviso = { missionId: string; channel: "interno" | "gerencial"; id: string };
type Assinante = { personId: string; enviar: (evento: string, dados: unknown) => void };

const assinantes = new Set<Assinante>();
let ouvinte: Promise<pg.Client> | null = null;

async function podeVer(personId: string, aviso: Aviso): Promise<boolean> {
  try {
    return await withPerson(getPool(), personId, async (db) => {
      const { rows } = await db.execute<{ ok: boolean }>(
        sql`SELECT app.canal_desde(${aviso.missionId}::uuid, ${aviso.channel}) IS NOT NULL AS ok`,
      );
      return Boolean(rows[0]?.ok);
    });
  } catch {
    return false;
  }
}

async function veConversa(personId: string, chatId: string): Promise<boolean> {
  try {
    return await withPerson(getPool(), personId, async (db) => {
      const { rows } = await db.execute<{ ok: boolean }>(sql`SELECT app.ve_conversa_whatsapp(${chatId}::uuid) AS ok`);
      return Boolean(rows[0]?.ok);
    });
  } catch {
    return false;
  }
}

function iniciarOuvinte(): Promise<pg.Client> {
  ouvinte ??= (async () => {
    const client = new pg.Client({ connectionString: getEnv().DATABASE_URL_APP, application_name: "omni-sse" });
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      if (msg.channel === "omni_avisos") {
        try {
          const { personId } = JSON.parse(msg.payload) as { personId: string };
          for (const a of assinantes) if (a.personId === personId) a.enviar("aviso", {});
        } catch {
          // aviso malformado: ignora
        }
        return;
      }
      if (msg.channel === "omni_chamadas") {
        try {
          const { personId, numberId, estado } = JSON.parse(msg.payload) as { personId: string; numberId: string; estado: string };
          for (const a of assinantes) if (a.personId === personId) a.enviar("chamada", { numberId, estado });
        } catch {
          // evento malformado: ignora
        }
        return;
      }
      if (msg.channel === "omni_whatsapp") {
        try {
          const { chatId } = JSON.parse(msg.payload) as { chatId: string };
          for (const a of assinantes) {
            void veConversa(a.personId, chatId).then((ok) => {
              if (ok) a.enviar("whatsapp", { chatId });
            });
          }
        } catch {
          // evento malformado: ignora
        }
        return;
      }
      if (msg.channel === "omni_email") {
        // E-mail novo na caixa pessoal (0067): só a dona da caixa.
        try {
          const { personId } = JSON.parse(msg.payload) as { personId: string };
          for (const a of assinantes) if (a.personId === personId) a.enviar("email", {});
        } catch {
          // evento malformado: ignora
        }
        return;
      }
      if (msg.channel !== "omni_mensagens") return;
      let aviso: Aviso;
      try {
        aviso = JSON.parse(msg.payload) as Aviso;
      } catch {
        return;
      }
      for (const a of assinantes) {
        void podeVer(a.personId, aviso).then((ok) => {
          if (ok) a.enviar("mensagem", { missionId: aviso.missionId, channel: aviso.channel });
        });
      }
    });
    client.on("error", (error) => {
      console.error("[sse] conexão de avisos caiu:", error.message);
      ouvinte = null; // a próxima assinatura reabre
    });
    await client.connect();
    await client.query("LISTEN omni_mensagens");
    await client.query("LISTEN omni_avisos");
    await client.query("LISTEN omni_whatsapp");
    await client.query("LISTEN omni_chamadas");
    await client.query("LISTEN omni_email");
    return client;
  })().catch((error: unknown) => {
    ouvinte = null;
    throw error;
  });
  return ouvinte;
}

/** Resposta SSE para uma pessoa. Fecha quando o navegador desconecta. */
// ---------------------------------------------------------------- linha de chamadas viva
// O serviço de voz desconecta a linha sem renovação por 20 s. A renovação pela tela
// depende de temporizador do navegador, que o Chrome reduz em abas em segundo plano —
// e é justamente com o Omni atrás de outra janela que se espera uma ligação. Enquanto a
// pessoa tiver o Omni aberto (conexão de eventos ativa), o servidor renova a linha dela.
// Com "Receber ligações no Omni" ligado, também reconecta a linha se ela cair (no
// máximo a cada 30 s), por exemplo depois de a Evolution reconectar ao WhatsApp.
const linhasVivas = new Map<string, { conexoes: number; receber: number; timer: ReturnType<typeof setInterval>; ultimaConexao: number }>();

async function renovarLinhas(personId: string) {
  const { chamadasConfiguradas, controlarLinha } = await import("./chamadas.ts");
  if (!chamadasConfiguradas()) return;
  const numeros = await withPerson(getPool(), personId, async (db) =>
    (await db.execute<{ id: string }>(sql`SELECT id FROM whatsapp_numbers WHERE owner_person_id = ${personId}::uuid AND status <> 'removido' AND phone IS NOT NULL`)).rows,
  );
  const viva = linhasVivas.get(personId);
  for (const n of numeros) {
    const s = await controlarLinha(personId, n.id, { action: "status" }).catch(() => null);
    const caiu = s && (s.connection.state === "desconectado" || s.connection.state === "erro") && !s.call;
    if (caiu && viva && viva.receber > 0 && Date.now() - viva.ultimaConexao > 30_000) {
      viva.ultimaConexao = Date.now();
      await controlarLinha(personId, n.id, { action: "connect" }).catch(() => undefined);
    }
  }
}

function manterLinha(personId: string, receber: boolean) {
  const atual = linhasVivas.get(personId);
  if (atual) {
    atual.conexoes += 1;
    if (receber) atual.receber += 1;
    return;
  }
  const timer = setInterval(() => void renovarLinhas(personId).catch(() => undefined), 5000);
  linhasVivas.set(personId, { conexoes: 1, receber: receber ? 1 : 0, timer, ultimaConexao: 0 });
}

function soltarLinha(personId: string, receber: boolean) {
  const atual = linhasVivas.get(personId);
  if (!atual) return;
  atual.conexoes -= 1;
  if (receber) atual.receber -= 1;
  if (atual.conexoes <= 0) {
    clearInterval(atual.timer);
    linhasVivas.delete(personId);
  }
}

export async function abrirEventos(personId: string, signal: AbortSignal, opcoes: { receberLigacoes?: boolean } = {}): Promise<Response> {
  const receber = Boolean(opcoes.receberLigacoes);
  await iniciarOuvinte();
  const encoder = new TextEncoder();
  let assinante: Assinante | null = null;
  let pulso: ReturnType<typeof setInterval> | null = null;

  let linhaMantida = false;
  const fechar = () => {
    if (assinante) assinantes.delete(assinante);
    if (pulso) clearInterval(pulso);
    if (linhaMantida) soltarLinha(personId, receber);
    linhaMantida = false;
    assinante = null;
    pulso = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const escrever = (texto: string) => {
        try {
          controller.enqueue(encoder.encode(texto));
        } catch {
          fechar();
        }
      };
      assinante = { personId, enviar: (evento, dados) => escrever(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`) };
      assinantes.add(assinante);
      manterLinha(personId, receber);
      linhaMantida = true;
      escrever("retry: 5000\n\n");
      pulso = setInterval(() => escrever(": pulso\n\n"), 25_000);
      signal.addEventListener("abort", () => {
        fechar();
        try {
          controller.close();
        } catch {
          // já fechado
        }
      });
    },
    cancel: fechar,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
