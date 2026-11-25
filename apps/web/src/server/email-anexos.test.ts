import { describe, expect, it } from "vitest";

import { ErroParaTela } from "../lib/erros.ts";
import { anexosSchema, lerAnexos, MAX_ANEXOS_BYTES } from "./email-anexos.ts";

const b64 = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64");

describe("anexos dos e-mails enviados", () => {
  it("lê, guarda o registro (sem o conteúdo) e normaliza o tipo", () => {
    const r = lerAnexos(anexosSchema.parse([{ nome: "proposta.pdf", tipo: "application/pdf", base64: b64(10) }, { nome: "a/b.txt", tipo: "não é tipo", base64: b64(3) }]));
    expect(r.registro).toEqual([
      { nome: "proposta.pdf", tipo: "application/pdf", tamanho: 10 },
      { nome: "a_b.txt", tipo: "application/octet-stream", tamanho: 3 },
    ]);
    expect(r.anexos[0]!.conteudo.length).toBe(10);
  });

  it("recusa acima de 3 MB no total, executáveis e scripts, vazio e mais de 10", () => {
    const metade = Math.floor(MAX_ANEXOS_BYTES / 2) + 10;
    expect(() => lerAnexos(anexosSchema.parse([{ nome: "a.pdf", base64: b64(metade) }, { nome: "b.pdf", base64: b64(metade) }]))).toThrow(/3 MB/);
    for (const nome of ["setup.exe", "x.BAT", "macro.vbs", "a.js", "atalho.lnk"]) expect(() => lerAnexos(anexosSchema.parse([{ nome, base64: b64(5) }]))).toThrow(ErroParaTela);
    expect(() => lerAnexos(anexosSchema.parse([{ nome: "vazio.txt", base64: "" }]))).toThrow(/vazio/);
    expect(anexosSchema.safeParse(Array.from({ length: 11 }, (_, i) => ({ nome: `${i}.txt`, base64: b64(1) }))).success).toBe(false);
  });
});
