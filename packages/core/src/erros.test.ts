import { describe, expect, it } from "vitest";

import { avaliarOperacao, deveAvisarErro, limparTextoDeErro, normalizarCaminho, resumirErro } from "./erros.ts";

describe("limparTextoDeErro", () => {
  it("tira e-mail, CPF, CNPJ, telefone e o valor citado pelo Postgres", () => {
    const t = limparTextoDeErro(
      'duplicate key value violates unique constraint "people_email_key" Key (email)=(ana.souza@cliente.com.br) CPF 123.456.789-09 CNPJ 12.345.678/0001-90 tel +55 47 99123-4567',
    );
    expect(t).not.toMatch(/ana\.souza|123\.456|12\.345|99123/);
    expect(t).toContain("people_email_key");
    expect(t).toContain("Key (email)=(<valor>)");
  });

  it("tira tokens, JWT, chaves longas e a query string das URLs", () => {
    const t = limparTextoDeErro(
      "falhou GET https://graph.microsoft.com/v1.0/me?access_token=abc123 com Bearer eyJhbGciOi.eyJzdWIi.c2lnbmF0 token=s3cr3t chave 0123456789abcdef0123456789abcdef0123",
    );
    expect(t).not.toMatch(/abc123|s3cr3t|eyJhbGciOi|0123456789abcdef/);
    expect(t).toContain("https://graph.microsoft.com/v1.0/me?<consulta>");
    expect(t).toContain("Bearer <segredo>");
  });

  it("mantém caminhos de arquivo da pilha e corta no limite", () => {
    expect(limparTextoDeErro("at f (/app/apps/worker/src/sync/filtroapp-missoes.ts:10:5)")).toContain("/app/apps/worker/src/sync/filtroapp-missoes.ts");
    expect(limparTextoDeErro("erro ".repeat(200)).length).toBe(500);
  });
});

describe("normalizarCaminho", () => {
  it("troca ids, tokens e números e tira a query string", () => {
    expect(normalizarCaminho("/api/arquivos/b!abc/01ABCDEF?download=1")).toBe("/api/arquivos/b!abc/:id");
    expect(normalizarCaminho("/api/calendar/apple/feed/9f1c0e1a-1111-4111-8111-111111111111.assinatura.ics")).toBe("/api/calendar/apple/feed/:id");
    expect(normalizarCaminho("/api/saude")).toBe("/api/saude");
    expect(normalizarCaminho("/")).toBe("/");
  });
});

describe("resumirErro", () => {
  it("agrupa a mesma falha com números diferentes e separa locais diferentes", () => {
    const a = resumirErro(new Error("timeout depois de 1500 ms"), "worker", "filtroapp-missoes");
    const b = resumirErro(new Error("timeout depois de 3000 ms"), "worker", "filtroapp-missoes");
    const c = resumirErro(new Error("timeout depois de 1500 ms"), "worker", "outlook-emails");
    // Erros criados na mesma linha têm a mesma pilha; a assinatura vem do local no código.
    expect(a.assinatura).toBe(b.assinatura);
    expect(a.assinatura).not.toBe(c.assinatura);
  });

  it("usa o código do Postgres no nome e limpa a causa", () => {
    const erro = Object.assign(new Error("Failed query"), { cause: { code: "23505", message: "Key (email)=(x@y.com) already exists" } });
    const r = resumirErro(erro, "web", "/_serverFn/:id");
    expect(r.nome).toBe("Error 23505");
    expect(r.mensagem).toContain("Key (email)=(<valor>)");
    expect(r.mensagem).not.toContain("x@y.com");
  });

  it("não guarda a consulta nem os parâmetros que o Drizzle põe na mensagem", () => {
    const erro = Object.assign(new Error("Failed query: update people set display_name = $1 where id = $2\nparams: Maria Silva,42"), {
      cause: { code: "23514", message: "new row violates check constraint" },
    });
    const r = resumirErro(erro, "web", "fn salvar");
    expect(r.mensagem).toBe("Falha na consulta ao banco (causa: new row violates check constraint)");
    expect(r.detalhe).not.toMatch(/Maria|display_name|params/);
    expect(r.detalhe).toMatch(/^Error 23514: Falha na consulta/);
  });

  it("aceita o que não é Error", () => {
    const r = resumirErro("caiu", "worker", "processo");
    expect(r.nome).toBe("string");
    expect(r.mensagem).toBe("caiu");
    expect(r.detalhe).toBeNull();
  });
});

describe("deveAvisarErro", () => {
  const agora = new Date("2026-11-26T12:00:00Z");
  it("avisa o erro novo", () => expect(deveAvisarErro({ ultimaVez: agora, avisadoEm: null }, agora)).toBe(true));
  it("não repete antes de 6 h", () =>
    expect(deveAvisarErro({ ultimaVez: agora, avisadoEm: new Date("2026-11-26T08:00:00Z") }, agora)).toBe(false));
  it("repete depois de 6 h se voltou a acontecer", () =>
    expect(deveAvisarErro({ ultimaVez: agora, avisadoEm: new Date("2026-11-26T05:00:00Z") }, agora)).toBe(true));
  it("não repete o que não voltou a acontecer", () =>
    expect(deveAvisarErro({ ultimaVez: new Date("2026-11-26T04:00:00Z"), avisadoEm: new Date("2026-11-26T05:00:00Z") }, agora)).toBe(false));
});

describe("avaliarOperacao", () => {
  const agora = new Date("2026-11-26T12:00:00Z");
  const ok = { status: "SUCCESS", uploadSucceeded: true, finishedAt: "2026-11-26T02:21:00+00:00", b2Uri: "b2://filtrovali-omni/daily" };
  const ensaioOk = { status: "SUCCESS", finishedAt: "2026-11-02T04:51:00+00:00" };

  it("tudo em dia não gera problema", () => {
    expect(avaliarOperacao({ ultimoBackup: { status: "SUCCESS" }, backupRemoto: ok, ensaio: ensaioOk }, agora)).toEqual([]);
  });

  it("aponta backup que falhou, B2 velho e ensaio velho", () => {
    const p = avaliarOperacao(
      {
        ultimoBackup: { status: "FAILURE" },
        backupRemoto: { ...ok, finishedAt: "2026-11-24T02:21:00+00:00" },
        ensaio: { status: "SUCCESS", finishedAt: "2026-10-02T04:51:00+00:00" },
      },
      agora,
    ).map((x) => x.chave);
    expect(p).toEqual(["backup:falhou", "backup:remoto-velho", "ensaio:velho"]);
  });

  it("aponta o que falta e o envio que falhou", () => {
    expect(avaliarOperacao({ ultimoBackup: null, backupRemoto: null, ensaio: null }, agora).map((x) => x.chave)).toEqual(["backup:sem-remoto", "ensaio:ausente"]);
    expect(
      avaliarOperacao({ ultimoBackup: null, backupRemoto: { ...ok, uploadSucceeded: false }, ensaio: { status: "FAILURE", message: "sanidade reprovada" } }, agora).map(
        (x) => x.chave,
      ),
    ).toEqual(["backup:remoto-falhou", "ensaio:falhou"]);
  });
});
