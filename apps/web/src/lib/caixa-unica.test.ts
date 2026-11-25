import { describe, expect, it } from "vitest";

import { acharContato, juntarContatos, sugestoesPorNome } from "./caixa-unica.ts";
import type { ConversaResumo } from "./conversas-fns.ts";
import type { ContatoDaAgenda, Correspondente } from "./unica-fns.ts";

const conversa = (id: string, nome: string, telefone: string | null, ultimaEm: string, extra: Partial<ConversaResumo> = {}): ConversaResumo => ({
  id,
  numero: { id: "n1", rotulo: "Meu WhatsApp" },
  grupo: false,
  nome,
  telefone,
  foto: null,
  ultimaEm,
  previa: `msg de ${nome}`,
  podeResponder: true,
  podeLigar: false,
  missoes: [],
  sugestoes: [],
  concluida: false,
  naoLidas: 0,
  marcadaNaoLida: false,
  lidaAte: null,
  ...extra,
});
const correspondente = (endereco: string, nome: string, ultimaEm: string, naoLidos = 0): Correspondente => ({
  endereco,
  nome,
  ultimaEm,
  assunto: `assunto de ${nome}`,
  previa: null,
  naoLidos,
  total: 1,
});

describe("caixa única: juntar WhatsApp e e-mail por contato", () => {
  const agenda: ContatoDaAgenda[] = [{ id: "c1", nome: "Ana Cliente", empresa: "Exemplo", telefones: ["5547900000099"], emails: ["ana@exemplo.com.br", "ana.compras@exemplo.com.br"], automaticos: [], noPrisma: false }];

  it("o contato da agenda vira um item com a conversa e os e-mails; o resto fica separado", () => {
    const itens = juntarContatos(
      [conversa("w1", "Ana (celular)", "5547900000099", "2026-11-17T10:00:00Z"), conversa("w2", "Grupo obra", null, "2026-11-17T09:00:00Z", { grupo: true })],
      [
        correspondente("ana@exemplo.com.br", "Ana", "2026-11-17T11:00:00Z", 1),
        correspondente("ana.compras@exemplo.com.br", "Ana Compras", "2026-11-10T11:00:00Z", 2),
        correspondente("bruno@fornecedor.exemplo", "Bruno", "2026-11-16T11:00:00Z", 1),
      ],
      agenda,
    );
    expect(itens.map((i) => i.chave)).toEqual(["c:c1", "w:w2", "e:bruno@fornecedor.exemplo"]);
    const ana = itens[0]!;
    expect(ana).toMatchObject({ nome: "Ana Cliente", empresa: "Exemplo", contatoId: "c1", canal: "email", emailsNaoLidos: 3, ultimaEm: "2026-11-17T11:00:00Z", previa: "assunto de Ana" });
    expect(ana.conversa?.id).toBe("w1");
    expect(ana.enderecos.sort()).toEqual(["ana.compras@exemplo.com.br", "ana@exemplo.com.br"]);
  });

  it("sem agenda, nada se junta (nem pelo nome); o mesmo contato em dois números fica com a conversa mais recente", () => {
    const soltos = juntarContatos([conversa("w1", "Bruno", "5547911112222", "2026-11-17T10:00:00Z")], [correspondente("bruno@fornecedor.exemplo", "Bruno", "2026-11-16T11:00:00Z")], []);
    expect(soltos.map((i) => i.chave)).toEqual(["w:w1", "e:bruno@fornecedor.exemplo"]);
    const dois = juntarContatos(
      [conversa("w1", "Ana", "5547900000099", "2026-11-15T10:00:00Z"), conversa("w9", "Ana", "5547900000099", "2026-11-17T10:00:00Z", { numero: { id: "n2", rotulo: "Outro" } })],
      [],
      agenda,
    );
    expect(dois).toHaveLength(1);
    expect(dois[0]!.conversa?.id).toBe("w9");
  });

  it("o item aberto continua aberto depois de vincular (a chave muda para o contato)", () => {
    const itens = juntarContatos([conversa("w1", "Ana (celular)", "5547900000099", "2026-11-17T10:00:00Z")], [correspondente("ana@exemplo.com.br", "Ana", "2026-11-17T11:00:00Z")], agenda);
    expect(acharContato(itens, "w:w1")?.chave).toBe("c:c1");
    expect(acharContato(itens, "e:ana@exemplo.com.br")?.chave).toBe("c:c1");
    expect(acharContato(itens, "e:ninguem@x.com")).toBeNull();
    expect(acharContato(itens, null)).toBeNull();
  });

  it("o jid do WhatsApp sem o 9 casa com o telefone da agenda", () => {
    const itens = juntarContatos([conversa("w1", "Ana", "554790000099", "2026-11-17T10:00:00Z")], [], [{ ...agenda[0]!, telefones: ["5547990000099"] }]);
    expect(itens[0]!.chave).toBe("c:c1");
  });

  it("mesma pessoa? só nome e sobrenome iguais, soltos, sem ambiguidade e não recusados", () => {
    const itens = juntarContatos(
      [
        conversa("w1", "Bruno Souza", "5547911112222", "2026-11-17T10:00:00Z"),
        conversa("w2", "Carla", "5547933334444", "2026-11-17T10:00:00Z"),
        conversa("w3", "Lia Lima", "5547955556666", "2026-11-17T10:00:00Z"),
        conversa("w4", "Lia Lima", "5547977778888", "2026-11-17T10:00:00Z"),
      ],
      [
        correspondente("bruno@fornecedor.exemplo", "Bruno Souza", "2026-11-16T11:00:00Z"),
        correspondente("carla@x.exemplo", "Carla", "2026-11-16T11:00:00Z"),
        correspondente("lia@x.exemplo", "Lia Lima", "2026-11-16T11:00:00Z"),
      ],
      [],
    );
    const s = sugestoesPorNome(itens, new Set());
    expect(s.map((x) => [x.endereco, x.telefone])).toEqual([["bruno@fornecedor.exemplo", "5547911112222"]]);
    expect(sugestoesPorNome(itens, new Set(["bruno@fornecedor.exemplo|5547911112222"]))).toEqual([]);
  });
});
