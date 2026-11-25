import { describe, expect, it } from "vitest";

import { detectarParticipantes, ehEmailDeSetor, ladoDoEmail } from "./participantes.ts";

const em = "2026-11-10T12:00:00Z";

describe("participantes da missão", () => {
  it("lado pelo domínio: Filtrovali, cliente (domínios do Prisma), terceiro; webmail fica a definir", () => {
    expect(ladoDoEmail("ana@filtrovali.com.br", [])).toBe("filtrovali");
    expect(ladoDoEmail("joao@portonorte.com.br", ["portonorte.com.br"])).toBe("cliente");
    expect(ladoDoEmail("vendas@hotelcentral.com", ["portonorte.com.br"])).toBe("terceiro");
    expect(ladoDoEmail("fulano@gmail.com", [])).toBe("a_definir");
    expect(ehEmailDeSetor("compras@portonorte.com.br")).toBe(true);
    expect(ehEmailDeSetor("financeiro.sul@x.com")).toBe(true);
    expect(ehEmailDeSetor("joao.silva@x.com")).toBe(false);
  });

  it("junta remetente, destinatários e cópia por endereço; nome mais usado; automáticos fora", () => {
    const r = detectarParticipantes({
      dominiosCliente: ["portonorte.com.br"],
      emails: [
        { de: { nome: "João Silva", endereco: "Joao@PortoNorte.com.br" }, para: [{ nome: "Ana", endereco: "ana@filtrovali.com.br" }], cc: [{ endereco: "compras@portonorte.com.br" }], em },
        { de: { nome: "Ana Souza", endereco: "ana@filtrovali.com.br" }, para: [{ nome: "João Silva", endereco: "joao@portonorte.com.br" }], cc: [{ endereco: "no-reply@sistema.com" }], em: "2026-11-11T12:00:00Z" },
      ],
      whatsapp: [],
    });
    expect(r.map((p) => p.chave).sort()).toEqual(["email:ana@filtrovali.com.br", "email:compras@portonorte.com.br", "email:joao@portonorte.com.br"]);
    const joao = r.find((p) => p.email === "joao@portonorte.com.br")!;
    expect(joao).toMatchObject({ nome: "João Silva", lado: "cliente", vezes: 2, origens: ["remetente", "destinatario"], ultimaVez: "2026-11-11T12:00:00Z" });
    expect(r.find((p) => p.email?.startsWith("compras"))).toMatchObject({ setor: true, origens: ["copia"], nome: null });
  });

  it("WhatsApp: telefone pelo jid; colaborador pelo telefone; LID sem telefone", () => {
    const r = detectarParticipantes({
      dominiosCliente: [],
      emails: [],
      whatsapp: [
        { jid: "5547999990001@s.whatsapp.net", nome: "Josinaldo", em },
        { jid: "5547999990001@s.whatsapp.net", nome: "Josinaldo", em },
        { jid: "5547988887777@s.whatsapp.net", nome: "Pedro", em },
        { jid: "123456789012345@lid", nome: "Cliente X", em },
      ],
      telefonesFiltrovali: ["(47) 98888-7777"],
    });
    expect(r[0]).toMatchObject({ telefone: "5547999990001", vezes: 2, lado: "a_definir", origens: ["whatsapp"] });
    expect(r.find((p) => p.nome === "Pedro")!.lado).toBe("filtrovali");
    expect(r.find((p) => p.nome === "Cliente X")!.telefone).toBeNull();
  });
});
