import { describe, expect, it } from "vitest";

import { trechoDaAssinatura, validarAssinatura } from "./assinatura.ts";

const email = `Bom dia, Ana.

Segue o cronograma revisado.

Atenciosamente,
João Silva
Coordenador de Manutenção
Porto Norte S.A.
(47) 3333-4444

De: Ana Souza <ana@filtrovali.com.br>
Enviado: segunda-feira
Assunto: cronograma
Assinatura antiga: Fulano, Diretor`;

describe("assinatura do e-mail", () => {
  it("pega o final do e-mail antes da conversa citada", () => {
    const t = trechoDaAssinatura(email);
    expect(t.endsWith("(47) 3333-4444")).toBe(true);
    expect(t).not.toContain("Diretor");
    expect(trechoDaAssinatura("> citado\nnada")).toBe("");
  });

  it("só aceita o que está escrito na assinatura", () => {
    const t = trechoDaAssinatura(email);
    expect(validarAssinatura({ nome: "João Silva", cargo: "coordenador de manutenção", empresa: "Porto Norte S.A.", telefone: "(47) 3333-4444" }, t)).toEqual({
      nome: "João Silva",
      cargo: "coordenador de manutenção",
      empresa: "Porto Norte S.A.",
      telefone: "(47) 3333-4444",
    });
    expect(validarAssinatura({ nome: "João Silva", cargo: "Gerente Geral", empresa: null, telefone: "(47) 99999-0000" }, t)).toEqual({ nome: "João Silva", cargo: null, empresa: null, telefone: null });
    expect(validarAssinatura(null, t)).toEqual({ nome: null, cargo: null, empresa: null, telefone: null });
  });
});
