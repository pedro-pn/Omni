/** Range do player das gravações. */

/** "bytes=a-b", "bytes=a-" ou "bytes=-n" → [inicio, fim]; null = inválido; undefined = sem Range. */
export function faixaPedida(range: string | null, total: number): [number, number] | null | undefined {
  if (!range) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let inicio: number, fim: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (!n) return null;
    inicio = Math.max(0, total - n);
    fim = total - 1;
  } else {
    inicio = Number(m[1]);
    fim = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  return inicio <= fim && inicio < total ? [inicio, fim] : null;
}
