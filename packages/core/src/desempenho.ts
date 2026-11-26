/**
 * Tempo por rota (E19, pilar 11.1): regras puras do que o web mede e como soma. O web chama
 * `medir` a cada requisição e grava `esvaziar()` no banco a cada minuto (app.registrar_desempenho,
 * migration 0084). Nada de usuário, parâmetro ou corpo: só a rota com os ids trocados.
 */

/** Limites das faixas de tempo (ms); a última faixa é "acima de 5000". */
export const FAIXAS_MS = [50, 100, 250, 500, 1000, 2500, 5000] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Caminhos que não entram: arquivos estáticos e o fluxo de eventos (conexão que fica aberta). */
export function semMedicao(caminho: string): boolean {
  return (
    caminho.startsWith("/assets/") ||
    caminho.startsWith("/marca/") ||
    caminho.startsWith("/icones/") ||
    caminho.startsWith("/audio/") ||
    caminho === "/api/eventos" ||
    caminho.startsWith("/_serverFn") || // medidas pelo nome, no middleware de start.ts
    /\.(js|css|png|svg|ico|webmanifest|json|woff2?|map|mp3|wav|webp|jpg)$/i.test(caminho)
  );
}

/**
 * Rota sem identificadores: uuid vira `:id`, número vira `:n` e trecho longo (token, id do Graph,
 * nome de arquivo) vira `:x`. Assim `/api/tarefas/anexo/<uuid>` agrupa num lugar só e nenhum
 * token ou e-mail entra na medição.
 */
export function rotaDe(metodo: string, caminho: string): string {
  const partes = caminho
    .split("?")[0]!
    .split("/")
    .map((p) => {
      if (!p) return p;
      if (UUID.test(p)) return ":id";
      if (/^\d+$/.test(p)) return ":n";
      if (p.length > 24 || /[@.%=]/.test(p)) return ":x";
      return p;
    });
  return `${metodo.toUpperCase()} ${partes.join("/") || "/"}`.slice(0, 200);
}

export type Medicao = { hora: string; rota: string; n: number; soma: number; max: number; erros: number; faixas: number[] };

export function faixaDe(ms: number): number {
  const i = FAIXAS_MS.findIndex((limite) => ms <= limite);
  return i === -1 ? FAIXAS_MS.length : i;
}

/** p95 aproximado pela faixa: o limite superior da faixa onde cai o 95º percentil (acima de 5 s, o máximo). */
export function p95(faixas: number[], max: number): number {
  const total = faixas.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let acumulado = 0;
  for (let i = 0; i < faixas.length; i++) {
    acumulado += faixas[i]!;
    if (acumulado >= total * 0.95) return i < FAIXAS_MS.length ? Math.min(FAIXAS_MS[i]!, max) : max;
  }
  return max;
}

/** Acumulador por hora e rota (um por processo do web). */
export class Medidor {
  private mapa = new Map<string, Medicao>();
  constructor(private agora: () => Date = () => new Date()) {}

  medir(rota: string, ms: number, erro: boolean): void {
    const hora = new Date(this.agora());
    hora.setUTCMinutes(0, 0, 0);
    const chave = `${hora.toISOString()}|${rota}`;
    let m = this.mapa.get(chave);
    if (!m) {
      if (this.mapa.size >= 2000) return; // proteção: rota inesperada demais não enche a memória
      m = { hora: hora.toISOString(), rota, n: 0, soma: 0, max: 0, erros: 0, faixas: Array(FAIXAS_MS.length + 1).fill(0) };
      this.mapa.set(chave, m);
    }
    const t = Math.max(0, Math.round(ms));
    m.n += 1;
    m.soma += t;
    m.max = Math.max(m.max, t);
    if (erro) m.erros += 1;
    m.faixas[faixaDe(t)]! += 1;
  }

  /** Entrega o que foi somado e zera. */
  esvaziar(): Medicao[] {
    const lista = [...this.mapa.values()];
    this.mapa.clear();
    return lista;
  }

  /** Devolve um lote que não pôde ser gravado (soma de novo ao que vier). */
  devolver(lista: Medicao[]): void {
    for (const m of lista) {
      const chave = `${m.hora}|${m.rota}`;
      const atual = this.mapa.get(chave);
      if (!atual) {
        if (this.mapa.size < 2000) this.mapa.set(chave, m);
        continue;
      }
      atual.n += m.n;
      atual.soma += m.soma;
      atual.max = Math.max(atual.max, m.max);
      atual.erros += m.erros;
      atual.faixas = atual.faixas.map((v, i) => v + (m.faixas[i] ?? 0));
    }
  }
}
