import { describe, expect, it } from "vitest";

import { ambienteDe, validarEnvWeb } from "./env.ts";

const base = { APP_ORIGIN: "https://omnistaging.filtrovali.com.br", DATABASE_URL_APP: "postgres://omni_app:x@postgres:5432/omni", AUTH_SECRET: "s".repeat(40) };

describe("ambiente do web", () => {
  it("chamadas exigem ativação explícita, serviço local e chave que não aparece nos erros", () => {
    expect(validarEnvWeb(base).CHAMADAS_HABILITADAS).toBe("off");
    const key = "chave-interna-de-teste-".repeat(3);
    expect(validarEnvWeb({ ...base, CHAMADAS_HABILITADAS: "on", CHAMADAS_SERVICO_URL: "http://127.0.0.1:8098", CHAMADAS_SERVICO_KEY: key }).CHAMADAS_HABILITADAS).toBe("on");
    for (const url of ["http://externo.invalid:8098", "invalida", "http://user:password@127.0.0.1:8098", "http://127.0.0.1:8098/?key=segredo"]) {
      expect(() => validarEnvWeb({ ...base, CHAMADAS_HABILITADAS: "on", CHAMADAS_SERVICO_URL: url, CHAMADAS_SERVICO_KEY: key })).toThrow(/CHAMADAS_SERVICO_URL/);
    }
    try { validarEnvWeb({ ...base, CHAMADAS_HABILITADAS: "on", CHAMADAS_SERVICO_KEY: key }); } catch (e) { expect((e as Error).message).not.toContain(key); }
    // Nome de serviço da rede interna: só no staging e na produção (contêineres).
    const voz = { CHAMADAS_HABILITADAS: "on", CHAMADAS_SERVICO_URL: "http://voz:8098", CHAMADAS_SERVICO_KEY: key };
    expect(() => validarEnvWeb({ ...base, ...voz })).toThrow(/CHAMADAS_SERVICO_URL/);
    expect(validarEnvWeb({ ...base, ...voz, NODE_ENV: "production", OMNI_AMBIENTE: "staging" }).CHAMADAS_HABILITADAS).toBe("on");
    for (const url of ["http://localhost:8098", "http://voz.filtrovali.com.br:8098"]) {
      expect(() => validarEnvWeb({ ...base, ...voz, CHAMADAS_SERVICO_URL: url, NODE_ENV: "production", OMNI_AMBIENTE: "staging" })).toThrow(/CHAMADAS_SERVICO_URL/);
    }
  });
  it("staging: build de produção com as travas de fora da produção", () => {
    const staging = { ...base, NODE_ENV: "production", OMNI_AMBIENTE: "staging" };
    expect(ambienteDe(validarEnvWeb(staging))).toBe("staging");
    expect(() => validarEnvWeb({ ...staging, EMAIL_ENVIO: "real" })).toThrow(/EMAIL_ENVIO/);
    expect(() => validarEnvWeb({ ...staging, WHATSAPP_ENVIO: "real" })).toThrow(/WHATSAPP_ENVIO/);
    expect(() => validarEnvWeb({ ...staging, PRISMA_OMNI_ENVIRONMENT: "production" })).toThrow(/PRISMA_OMNI_ENVIRONMENT/);
    expect(() => validarEnvWeb({ ...staging, AUTH_DEV_LOGIN: "on" })).toThrow(/AUTH_DEV_LOGIN/);
  });

  it("produção: libera os envios reais; sem OMNI_AMBIENTE, o NODE_ENV decide", () => {
    const producao = { ...base, APP_ORIGIN: "https://omni.filtrovali.com.br", NODE_ENV: "production" };
    expect(ambienteDe(validarEnvWeb(producao))).toBe("producao");
    expect(validarEnvWeb({ ...producao, EMAIL_ENVIO: "real", WHATSAPP_ENVIO: "real" }).EMAIL_ENVIO).toBe("real");
    expect(ambienteDe(validarEnvWeb({ ...base, APP_ORIGIN: "http://localhost:3000" }))).toBe("desenvolvimento");
    expect(() => validarEnvWeb({ ...base, OMNI_AMBIENTE: "producao" })).toThrow(/OMNI_AMBIENTE/);
  });
});
