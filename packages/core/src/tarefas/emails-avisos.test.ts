import { describe, expect, it } from "vitest";

import { emailDeAvisos, emailSemanalAtrasadas, emailSemanalDaSemana, preferenciaDoAviso } from "./emails-avisos.ts";

const app = "https://omni.filtrovali.com.br";
const tarefa = (id: string, data: string, prioridade: number, titulo = `Tarefa ${id}`) => ({ id, titulo, projeto: null, data, prioridade });

describe("e-mails das tarefas (modelos do Foco)", () => {
  it("avisos: assunto no singular e plural, link de cada tarefa, HTML escapado", () => {
    const um = emailDeAvisos({ app, nome: "Ana", itens: [{ titulo: "Bruno comentou em <script>", corpo: "ok & feito", tarefaId: "t1" }] });
    expect(um.assunto).toBe("[Omni] 1 novo aviso");
    expect(um.texto).toContain(`${app}/?tarefa=t1`);
    expect(um.html).toContain("&lt;script&gt;");
    expect(um.html).not.toContain("<script>");
    expect(um.html).toContain("ok &amp; feito");
    expect(emailDeAvisos({ app, nome: "Ana", itens: [um, um].map(() => ({ titulo: "x", corpo: "", tarefaId: null })) }).assunto).toBe("[Omni] 2 novos avisos");
  });

  it("atrasadas: dias de atraso pela data de hoje, mais antigas primeiro", () => {
    const e = emailSemanalAtrasadas({ app, nome: "Ana", hoje: "2026-11-16", tarefas: [tarefa("b", "2026-11-13", 1), tarefa("a", "2026-11-02", 4)] });
    expect(e.texto.indexOf("Tarefa a")).toBeLessThan(e.texto.indexOf("Tarefa b"));
    expect(e.texto).toContain("14 dia(s) em atraso");
    expect(e.texto).toContain("Vencimento: 13/11/2026 · 3 dia(s)");
  });

  it("semana: maior prioridade primeiro e, dentro dela, pela data", () => {
    const e = emailSemanalDaSemana({ app, nome: "Ana", inicio: "2026-11-16", fim: "2026-11-22", tarefas: [tarefa("c", "2026-11-17", 3), tarefa("d", "2026-11-20", 1), tarefa("e", "2026-11-18", 1)] });
    const ordem = ["Tarefa e", "Tarefa d", "Tarefa c"].map((t) => e.texto.indexOf(t));
    expect(ordem).toEqual([...ordem].sort((x, y) => x - y));
    expect(e.texto).toContain("P1 · Urgente · Data: 18/11/2026 · Caixa pessoal");
  });

  it("só avisos de tarefa vão por e-mail, cada um com a sua preferência", () => {
    expect(preferenciaDoAviso("tarefa_reacao")).toBe("comentarios");
    expect(preferenciaDoAviso("tarefa_lembrete")).toBe("lembretes");
    expect(preferenciaDoAviso("ia_pergunta")).toBeNull();
    expect(preferenciaDoAviso("chamada_perdida")).toBeNull();
  });
});
