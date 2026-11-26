import { z } from "zod";

import { WhatsAppError } from "./tipos.ts";

/**
 * Cliente da ponte de ações do Omni dentro da Evolution (experiments/whatsapp-chamada/
 * evolution-bridge/acoes.mjs): a agenda do celular (só os contatos salvos, com o nome salvo),
 * adicionar contato (salva no celular), fixar conversa, favoritar e fixar mensagem. Rede
 * interna do compose, com token; a linha é achada pelo telefone do número.
 */

export type ContatoSalvo = { jid: string; lid: string | null; telefone: string | null; nome: string };
/** O que o WhatsApp mandou na leitura (o Baileys não devolve erro quando a coleção falha). */
export type DiagnosticoDaAgenda = Record<string, number | null>;

const contatoSchema = z.object({ jid: z.string().max(80), lid: z.string().max(80).nullable(), telefone: z.string().max(80).nullable(), nome: z.string().min(1).max(120) });

export class PonteDeAcoes {
  private readonly base: string;
  constructor(private readonly o: { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number }) {
    const u = new URL(o.url);
    if (u.protocol !== "http:" || u.pathname !== "/" || u.username || o.token.length < 32) throw new WhatsAppError("Ponte de ações mal configurada", 500, "configuracao");
    this.base = `${u.protocol}//${u.host}`;
  }

  private async chamar(corpo: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    let r: Response;
    try {
      r = await (this.o.fetch ?? fetch)(`${this.base}/v1/acoes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs ?? this.o.timeoutMs ?? 15_000),
        redirect: "error",
      });
    } catch {
      throw new WhatsAppError("Ponte de ações fora do ar", 503, "indisponivel");
    }
    const dados = (await r.json().catch(() => null)) as { erro?: string } | null;
    if (!r.ok) throw new WhatsAppError(`Ponte de ações respondeu ${r.status}`, r.status, dados?.erro ?? undefined);
    return dados;
  }

  /** Os contatos salvos na agenda do celular deste número (a primeira leitura baixa a agenda de novo) e o diagnóstico. */
  async contatos(telefone: string, recarregar = false): Promise<{ contatos: ContatoSalvo[]; diagnostico: DiagnosticoDaAgenda | null }> {
    const d = await this.chamar({ telefone, acao: "contatos", recarregar }, 90_000);
    const lista = z.object({ contatos: z.array(z.unknown()), diagnostico: z.record(z.string(), z.number().nullable()).optional() }).safeParse(d);
    if (!lista.success) throw new WhatsAppError("Resposta inesperada da ponte", 502);
    return {
      contatos: lista.data.contatos.flatMap((c) => {
        const p = contatoSchema.safeParse(c);
        return p.success ? [p.data] : [];
      }),
      diagnostico: lista.data.diagnostico ?? null,
    };
  }

  salvarContato(telefone: string, jid: string, nome: string) {
    return this.chamar({ telefone, acao: "contato", jid, nome }).then(() => undefined);
  }

  fixarConversa(telefone: string, jid: string, fixar: boolean) {
    return this.chamar({ telefone, acao: "fixar-conversa", jid, fixar }).then(() => undefined);
  }

  favoritar(telefone: string, jid: string, id: string, fromMe: boolean, favorita: boolean) {
    return this.chamar({ telefone, acao: "favoritar", jid, id, fromMe, favorita }).then(() => undefined);
  }

  fixarMensagem(telefone: string, jid: string, m: { id: string; fromMe: boolean; participante?: string | null }, fixar: boolean) {
    return this.chamar({ telefone, acao: "fixar-mensagem", jid, id: m.id, fromMe: m.fromMe, participante: m.participante ?? null, fixar }).then(() => undefined);
  }
}
