import { appendFileSync, readFileSync } from "node:fs";

import { entradaLeituraRdo, ESQUEMA_LEITURA_RDO, SISTEMA_LEITURA_RDO, validarPontosDoModelo, VERSAO_PROMPT_RDO } from "@omni/core";
import { OpenAiClient } from "@omni/integrations/openai";

/**
 * Avaliação da leitura dos RDOs (Fase 8): roda os casos fictícios de
 * `avaliacao-rdos.json` no modelo e compara com o esperado. Rode sempre que
 * mudar as instruções (VERSAO_PROMPT_RDO) ou o modelo:
 *   npm run ia:avaliar                 (modelo de OPENAI_MODEL)
 *   npm run ia:avaliar -- gpt-6-luna   (outro modelo)
 */

const chave = process.env.OPENAI_API_KEY;
if (!chave) throw new Error("Defina OPENAI_API_KEY no .env");
const modelo = process.argv[2] ?? process.env.OPENAI_MODEL ?? "gpt-6-luna";
const { casos } = JSON.parse(readFileSync(new URL("./avaliacao-rdos.json", import.meta.url), "utf8")) as {
  casos: { id: string; texto: string; esperado: string[] }[];
};
const llm = new OpenAiClient({ apiKey: chave });
const regime = { trabalhaSabado: false, trabalhaDomingo: false, jornada: "8h48" };

const linhas: string[] = [];
let acertos = 0;
let falsosAlarmes = 0;
let perdidos = 0;
let tokens = 0;
for (const c of casos) {
  const r = await llm.estruturado<{ pontos: unknown }>({
    modelo,
    sistema: SISTEMA_LEITURA_RDO,
    entrada: entradaLeituraRdo({ data: "2026-11-04", texto: c.texto, minutosTrabalhados: 528, minutosExtras: null, motivoExtra: null }, regime),
    nome: "leitura_rdo",
    esquema: ESQUEMA_LEITURA_RDO as unknown as Record<string, unknown>,
  });
  tokens += r.tokensEntrada + r.tokensSaida;
  const achados = new Set(validarPontosDoModelo(r.dados.pontos, c.texto).map((p) => p.tipo as string));
  const esperado = new Set(c.esperado);
  const ok = [...esperado].filter((t) => achados.has(t)).length;
  const fa = [...achados].filter((t) => !esperado.has(t)).length;
  acertos += ok;
  falsosAlarmes += fa;
  perdidos += esperado.size - ok;
  const sinal = fa === 0 && ok === esperado.size ? "✓" : "✗";
  console.log(`${sinal} ${c.id.padEnd(10)} esperado [${[...esperado].join(", ")}] · achou [${[...achados].join(", ")}]`);
  linhas.push(`| ${sinal} | ${c.id} | ${[...esperado].join(", ") || "—"} | ${[...achados].join(", ") || "—"} |`);
}
const total = casos.reduce((n, c) => n + c.esperado.length, 0);
console.log(`\n${modelo} · instruções ${VERSAO_PROMPT_RDO} · ${casos.length} casos · ${tokens} tokens`);
console.log(`Encontrou ${acertos} de ${total} pontos esperados · ${perdidos} perdidos · ${falsosAlarmes} falsos alarmes`);
// No GitHub Actions, o resultado vai também para o resumo da execução.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### Avaliação da leitura dos RDOs`,
      `${modelo} · instruções ${VERSAO_PROMPT_RDO} · ${casos.length} casos · ${tokens} tokens`,
      ``,
      `Encontrou **${acertos} de ${total}** pontos esperados · ${perdidos} perdidos · ${falsosAlarmes} falsos alarmes (limite: 2 erros)`,
      ``,
      `| | Caso | Esperado | Achou |`,
      `|---|---|---|---|`,
      ...linhas,
      ``,
    ].join("\n"),
  );
}
process.exitCode = perdidos + falsosAlarmes > 2 ? 1 : 0;
