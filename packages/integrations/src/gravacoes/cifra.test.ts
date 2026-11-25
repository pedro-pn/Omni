import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BLOCO,
  CABECALHO,
  cifrarGravacao,
  CifraGravacaoError,
  decifrarGravacao,
  decifrarTrecho,
  desembrulharChave,
  embrulharChave,
  novaChave,
  tamanhoCifrado,
  trechoCifrado,
} from "./cifra.ts";

const ID = "6b1f1d2e-1111-4222-8333-444455556666";
const ler = async (s: ReadableStream<Uint8Array>) => {
  const partes: Uint8Array[] = [];
  const leitor = s.getReader();
  for (let r = await leitor.read(); !r.done; r = await leitor.read()) partes.push(r.value);
  return Buffer.concat(partes);
};
const emPedacos = (b: Uint8Array, tamanho: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let o = 0; o < b.byteLength; o += tamanho) c.enqueue(b.subarray(o, o + tamanho));
      c.close();
    },
  });

describe("cifra das gravações", () => {
  const original = randomBytes(3 * BLOCO + 1234);
  const chave = novaChave();
  const cifrado = cifrarGravacao(original, chave);

  it("ida e volta; o arquivo não contém o original; tamanho previsto", () => {
    expect(cifrado.byteLength).toBe(tamanhoCifrado(original.byteLength));
    expect(Buffer.from(cifrado).includes(original.subarray(0, 64))).toBe(false);
    expect(Buffer.from(decifrarGravacao(cifrado, chave)).equals(original)).toBe(true);
  });

  it("chave errada, bloco trocado, arquivo cortado ou byte alterado: recusa", () => {
    expect(() => decifrarGravacao(cifrado, novaChave())).toThrow(CifraGravacaoError);
    const alterado = Buffer.from(cifrado);
    alterado[CABECALHO + 10]! ^= 1;
    expect(() => decifrarGravacao(alterado, chave)).toThrow(CifraGravacaoError);
    expect(() => decifrarGravacao(cifrado.subarray(0, cifrado.byteLength - 1), chave)).toThrow(CifraGravacaoError);
    // Troca de dois blocos inteiros (mesmo tamanho): a posição está autenticada.
    const n = BLOCO + 16;
    const trocado = Buffer.from(cifrado);
    Buffer.from(cifrado.subarray(CABECALHO + n, CABECALHO + 2 * n)).copy(trocado, CABECALHO);
    Buffer.from(cifrado.subarray(CABECALHO, CABECALHO + n)).copy(trocado, CABECALHO + n);
    expect(() => decifrarGravacao(trocado, chave)).toThrow(CifraGravacaoError);
    // Cortar no fim de um bloco e fingir que acabou: o tamanho total também está autenticado.
    const cortado = Buffer.from(cifrado.subarray(0, CABECALHO + n));
    cortado.writeBigUInt64BE(BigInt(BLOCO), 12);
    expect(() => decifrarGravacao(cortado, chave)).toThrow(CifraGravacaoError);
  });

  it("trechos para o player (Range), em qualquer fatiamento da rede", async () => {
    const total = original.byteLength;
    for (const [inicio, fim] of [[0, 0], [0, total - 1], [BLOCO - 5, BLOCO + 5], [2 * BLOCO, 2 * BLOCO], [total - 10, total - 1], [100, 3 * BLOCO + 10]] as const) {
      const t = trechoCifrado(inicio, fim, total);
      for (const pedaco of [7, 4096, 1 << 20]) {
        const parte = await ler(decifrarTrecho(emPedacos(cifrado.subarray(t.de, t.ate + 1), pedaco), chave, total, inicio, fim));
        expect(parte.equals(original.subarray(inicio, fim + 1))).toBe(true);
      }
    }
    expect(() => trechoCifrado(0, total, total)).toThrow(CifraGravacaoError);
    // Trecho incompleto (a conexão caiu no meio): erro, não um áudio cortado em silêncio.
    const t = trechoCifrado(0, total - 1, total);
    await expect(ler(decifrarTrecho(emPedacos(cifrado.subarray(t.de, t.ate), 4096), chave, total, 0, total - 1))).rejects.toThrow(CifraGravacaoError);
  });

  it("chave embrulhada pela mestra só abre para a mesma ligação", () => {
    const mestra = randomBytes(32);
    const e = embrulharChave(chave, mestra, ID);
    expect(e.length).toBe(60);
    expect(desembrulharChave(e, mestra, ID).equals(chave)).toBe(true);
    expect(() => desembrulharChave(e, mestra, "outra-ligacao")).toThrow(CifraGravacaoError);
    expect(() => desembrulharChave(e, randomBytes(32), ID)).toThrow(CifraGravacaoError);
  });
});
