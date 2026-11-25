import { describe, expect, it } from "vitest";

import { conferirOrigem } from "./csrf.ts";

const base = { appOrigin: "https://omni.filtrovali.com.br", secFetchSite: null as string | null };
const post = (caminho: string, origin: string | null, secFetchSite: string | null = null) => conferirOrigem({ ...base, metodo: "POST", caminho, origin, secFetchSite });

describe("conferirOrigem", () => {
  it("deixa passar o que só lê", () => {
    expect(conferirOrigem({ ...base, metodo: "GET", caminho: "/_serverFn/x", origin: "https://evil.example" }).ok).toBe(true);
  });

  it("server function da própria origem passa; de outra origem, do staging ou nula, não", () => {
    expect(post("/_serverFn/abc", "https://omni.filtrovali.com.br").ok).toBe(true);
    expect(post("/_serverFn/abc", "https://evil.example").ok).toBe(false);
    // Mesmo site para o SameSite=Lax, mas outra origem: recusa.
    expect(post("/_serverFn/abc", "https://omnistaging.filtrovali.com.br").ok).toBe(false);
    expect(post("/_serverFn/abc", "null")).toEqual({ ok: false, motivo: "origem nula" });
  });

  it("sem Origin: recusa se o navegador disser que veio de outro site; cliente sem navegador passa", () => {
    expect(post("/auth/sair", null, "cross-site").ok).toBe(false);
    expect(post("/auth/sair", null, "same-site").ok).toBe(false);
    expect(post("/auth/sair", null, "same-origin").ok).toBe(true);
    expect(post("/auth/sair", null, null).ok).toBe(true);
  });

  it("rotas chamadas por servidores, com credencial própria, ficam de fora", () => {
    for (const c of ["/api/v1/tasks", "/api/prisma-authorization/token", "/api/whatsapp/webhook", "/api/graph/avisos", "/api/chamadas/eventos", "/api/csp-relatorio"]) {
      expect(post(c, "https://evil.example").ok, c).toBe(true);
    }
    // O prefixo precisa casar de verdade.
    expect(post("/api/v1x/tasks", "https://evil.example").ok).toBe(false);
  });

  it("vale para PUT, PATCH e DELETE", () => {
    for (const metodo of ["PUT", "PATCH", "DELETE", "delete"]) {
      expect(conferirOrigem({ ...base, metodo, caminho: "/api/tarefas/anexo/1", origin: "https://evil.example" }).ok, metodo).toBe(false);
    }
  });
});
