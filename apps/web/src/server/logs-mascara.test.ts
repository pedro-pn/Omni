import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Logs centralizados (E20, pilar 12.2): aplica as máscaras de deploy/logs/config.alloy (lidas do
 * próprio arquivo) a linhas de exemplo, como o Alloy faz antes de enviar ao Grafana Cloud. Mudou a
 * configuração, este teste confere de novo. O Alloy usa RE2; as expressões daqui são compatíveis.
 */
const CONFIG = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "deploy", "logs", "config.alloy"), "utf8");

const textoAlloy = (s: string) => JSON.parse(`"${s}"`) as string; // as strings do Alloy seguem o escape do JSON
const regex = (e: string) => (e.startsWith("(?i)") ? new RegExp(e.slice(4), "gi") : new RegExp(e, "g"));

const trocas = [...CONFIG.matchAll(/stage\.replace \{\s*expression = "((?:[^"\\]|\\.)*)"\s*replace\s*= "([^"]*)"/g)].map((m) => ({
  re: regex(textoAlloy(m[1]!)),
  por: m[2]!,
}));
const descartes = [...CONFIG.matchAll(/stage\.drop \{\s*expression\s*= "((?:[^"\\]|\\.)*)"/g)].map((m) => regex(textoAlloy(m[1]!)));

/** Como o stage.replace: troca o primeiro grupo de captura (ou o trecho inteiro, sem grupo) em cada ocorrência. */
function mascarar(linha: string): string | null {
  if (descartes.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(linha))) return null;
  let s = linha;
  for (const { re, por } of trocas) {
    s = s.replace(re, (inteiro, grupo?: unknown) => (typeof grupo === "string" ? inteiro.replace(grupo, por) : por));
  }
  return s;
}

describe("máscara dos logs enviados ao Grafana (deploy/logs/config.alloy)", () => {
  it("lê as regras do arquivo", () => {
    expect(trocas.length).toBeGreaterThanOrEqual(7);
    expect(descartes.length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["[entra] login de fulano.silva@filtrovali.com.br recusado", "[entra] login de <email> recusado"],
    ["mensagem de 5547999990000@s.whatsapp.net", "mensagem de <email>"],
    ["chamada para 5547999990000 encerrada", "chamada para <telefone> encerrada"],
    ["CPF 123.456.789-00 na consulta", "CPF <cpf> na consulta"],
    ["conectando em postgres://omni_app:s3nh4-forte@postgres:5432/omni", "conectando em postgres://omni_app:<redacted>@postgres:5432/omni"],
    ["Authorization: Bearer abc.def-123_xyz", "Authorization: Bearer <token>"],
    ["chave foco_live_0123456789abcdef0123456789abcdef usada", "chave <api-token> usada"],
    ["GET /api/x?token=segredo123&outro=1", "GET /api/x?token=<redacted>&outro=1"],
    ["POST /api/graph/avisos?validationToken=abc%20def", "POST /api/graph/avisos?validationToken=<redacted>"],
  ])("%s", (entrada, esperado) => {
    expect(mascarar(entrada)).toBe(esperado);
  });

  it("descarta os parâmetros das consultas do Postgres", () => {
    expect(mascarar("2026-11-26 10:00:00 UTC [1] DETAIL:  Parameters: $1 = 'fulano@x.com'")).toBeNull();
    expect(mascarar("2026-11-26 10:00:00 UTC [1] DETAIL:  parameters: $1 = '123'")).toBeNull();
  });

  it("não estraga o que não é dado pessoal", () => {
    const linha = '{"job":"filtroapp-missoes","at":"2026-11-26T13:44:57.011Z","projetos":89,"erros":0}';
    expect(mascarar(linha)).toBe(linha);
  });

  it("deixa de fora a Evolution, o Redis dela e o serviço de voz", () => {
    expect(CONFIG).toMatch(/regex\s+= "evolution\.\*\|voz"\s+action\s+= "drop"/);
  });
});
