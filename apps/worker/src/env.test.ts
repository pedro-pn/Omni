import { describe, expect, it } from "vitest";

import { loadWorkerEnv } from "./env.ts";

describe("loadWorkerEnv", () => {
  it("aceita uma configuração válida", () => {
    const env = loadWorkerEnv({ DATABASE_URL_WORKER: "postgres://omni_worker:x@localhost:5433/omni" });
    expect(env.TZ_EMPRESA).toBe("America/Sao_Paulo");
  });

  it("token do filtroAPP vazio no .env conta como não definido", () => {
    const env = loadWorkerEnv({ DATABASE_URL_WORKER: "postgres://omni_worker:x@localhost:5433/omni", FILTROAPP_API_TOKEN: "" });
    expect(env.FILTROAPP_API_TOKEN).toBeUndefined();
  });

  it("fora da produção, nada grava de verdade no filtroAPP de produção", () => {
    const base = { DATABASE_URL_WORKER: "postgres://omni_worker:x@localhost:5433/omni", NODE_ENV: "development" };
    expect(loadWorkerEnv(base).FILTROAPP_ESCRITA).toBe("desligada");
    expect(() => loadWorkerEnv({ ...base, FILTROAPP_ESCRITA: "real" })).toThrow(/FILTROAPP_ESCRITA/);
    expect(loadWorkerEnv({ ...base, FILTROAPP_ESCRITA: "simulada" }).FILTROAPP_ESCRITA).toBe("simulada");
    // contra a homologação do filtroAPP pode gravar
    expect(
      loadWorkerEnv({ ...base, FILTROAPP_ESCRITA: "real", FILTROAPP_API_URL: "https://filtrostaging.filtrovali.com.br/api/integracoes/v1" }).FILTROAPP_ESCRITA,
    ).toBe("real");
    // na produção do Omni pode
    expect(loadWorkerEnv({ ...base, NODE_ENV: "production", FILTROAPP_ESCRITA: "real" }).FILTROAPP_ESCRITA).toBe("real");
  });

  it("fora da produção, só o sandbox do Prisma", () => {
    const base = { DATABASE_URL_WORKER: "postgres://omni_worker:x@localhost:5433/omni" };
    expect(() => loadWorkerEnv({ ...base, PRISMA_OMNI_ENVIRONMENT: "production" })).toThrow(/PRISMA_OMNI_ENVIRONMENT/);
    expect(loadWorkerEnv({ ...base, NODE_ENV: "production", PRISMA_OMNI_ENVIRONMENT: "production" }).PRISMA_OMNI_ENVIRONMENT).toBe("production");
  });

  it("aviso imediato do Graph: só HTTPS; fora da produção, nunca no endereço da produção", () => {
    const base = { DATABASE_URL_WORKER: "postgres://omni_worker:x@localhost:5433/omni", EMAIL_AVISO_IMEDIATO: "ligado" };
    expect(() => loadWorkerEnv(base)).toThrow(/EMAIL_AVISO_IMEDIATO/);
    expect(() => loadWorkerEnv({ ...base, APP_ORIGIN: "http://localhost:3000" })).toThrow(/APP_ORIGIN/);
    expect(loadWorkerEnv({ ...base, APP_ORIGIN: "https://omnistaging.filtrovali.com.br" }).EMAIL_AVISO_IMEDIATO).toBe("ligado");
    expect(loadWorkerEnv({ ...base, NODE_ENV: "production", OMNI_AMBIENTE: "producao" }).EMAIL_AVISO_IMEDIATO).toBe("ligado");
    expect(loadWorkerEnv({ DATABASE_URL_WORKER: base.DATABASE_URL_WORKER }).EMAIL_AVISO_IMEDIATO).toBe("desligado");
  });

  it("recusa sem banco e não vaza valores na mensagem", () => {
    expect(() => loadWorkerEnv({ DATABASE_URL_WORKER: "segredo-invalido" })).toThrow(/DATABASE_URL_WORKER/);
    expect(() => loadWorkerEnv({ DATABASE_URL_WORKER: "segredo-invalido" })).not.toThrow(/segredo/);
  });

  it("staging roda com o build de produção, mas com as travas de fora da produção", () => {
    const staging = { DATABASE_URL_WORKER: "postgres://omni_worker:x@db:5432/omni", NODE_ENV: "production", OMNI_AMBIENTE: "staging" };
    expect(() => loadWorkerEnv({ ...staging, FILTROAPP_ESCRITA: "real" })).toThrow(/FILTROAPP_ESCRITA/);
    expect(() => loadWorkerEnv({ ...staging, PRISMA_OMNI_ENVIRONMENT: "production" })).toThrow(/PRISMA_OMNI_ENVIRONMENT/);
    expect(loadWorkerEnv({ ...staging, FILTROAPP_ESCRITA: "simulada" }).FILTROAPP_ESCRITA).toBe("simulada");
    // "produção" declarada exige o build de produção
    expect(() => loadWorkerEnv({ DATABASE_URL_WORKER: staging.DATABASE_URL_WORKER, NODE_ENV: "development", OMNI_AMBIENTE: "producao" })).toThrow(/OMNI_AMBIENTE/);
  });

  it("variáveis vazias vindas do compose valem como ausentes (o worker sobe sem o Graph)", () => {
    const env = loadWorkerEnv({
      DATABASE_URL_WORKER: "postgres://omni_worker:x@db:5432/omni",
      GRAPH_TENANT_ID: "",
      GRAPH_CLIENT_ID: "",
      GRAPH_PRIVATE_KEY_PATH: "",
      GRAPH_CERT_SHA256_THUMBPRINT: "",
      WEB_PUSH_PUBLIC_KEY: "",
      WHATSAPP_EVOLUTION_URL: "",
      OPENAI_API_KEY: "",
    });
    expect([env.GRAPH_TENANT_ID, env.GRAPH_CERT_SHA256_THUMBPRINT, env.WEB_PUSH_PUBLIC_KEY]).toEqual([undefined, undefined, undefined]);
  });
});

