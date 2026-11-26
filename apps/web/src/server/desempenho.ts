import { Medidor, rotaDe, semMedicao } from "@omni/core";

import { getPool } from "./db.ts";

/**
 * Tempo por rota no web (E19; regras em packages/core/src/desempenho.ts). Um medidor por processo,
 * gravado a cada minuto por app.registrar_desempenho (migration 0084). Se o banco falhar, o lote volta
 * para o medidor e vai na próxima; medir nunca derruba nem atrasa a requisição.
 */
const medidor = new Medidor();
let relogio: ReturnType<typeof setInterval> | null = null;

async function gravar(): Promise<void> {
  const lote = medidor.esvaziar();
  if (!lote.length) return;
  try {
    await getPool().query("SELECT app.registrar_desempenho($1::jsonb)", [JSON.stringify(lote)]);
  } catch (erro) {
    medidor.devolver(lote);
    console.error("[desempenho] não gravou:", (erro as Error).message);
  }
}

function ligar(): void {
  if (relogio) return;
  relogio = setInterval(() => void gravar(), 60_000);
  relogio.unref?.();
}

/** Requisição HTTP (páginas e rotas de /api). */
export function medirRequisicao(metodo: string, caminho: string, ms: number, status: number): void {
  if (semMedicao(caminho)) return;
  ligar();
  medidor.medir(rotaDe(metodo, caminho), ms, status >= 500);
}

/** Server function, pelo nome (o caminho /_serverFn/<hash> não diz qual é). */
export function medirFuncao(nome: string | undefined, ms: number, erro: boolean): void {
  ligar();
  medidor.medir(`fn ${(nome ?? "?").slice(0, 100)}`, ms, erro);
}
