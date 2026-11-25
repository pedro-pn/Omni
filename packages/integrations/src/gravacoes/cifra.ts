import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifra das gravações das ligações guardadas no SharePoint (0053).
 *
 * - Cada gravação tem a própria chave (32 bytes aleatórios). Ela fica no banco do
 *   Omni "embrulhada" pela chave mestra do servidor (GRAVACOES_CHAVE_MESTRA), com o
 *   id da ligação como dado autenticado: não serve para outra ligação.
 * - O arquivo é cifrado em blocos de 64 KiB com AES-256-GCM. Cada bloco autentica a
 *   própria posição, se é o último e o tamanho total: não dá para trocar, cortar ou
 *   reordenar blocos. Blocos permitem decifrar só o trecho que o player pede (Range).
 * - Excluir a gravação apaga a chave (no banco): o arquivo vira lixo ilegível,
 *   mesmo se sobrar uma cópia no SharePoint.
 *
 * Arquivo: "OMNIGRV1" | tamanho do bloco (u32) | tamanho original (u64) | blocos.
 * Bloco i: AES-256-GCM(chave, nonce = 0⁴ ‖ i (u64), aad = magia ‖ total ‖ i ‖ último) ‖ tag (16).
 */

const MAGIA = Buffer.from("OMNIGRV1", "ascii");
export const BLOCO = 64 * 1024;
export const CABECALHO = 20;
const TAG = 16;

export class CifraGravacaoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CifraGravacaoError";
  }
}

export function chaveMestra(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new CifraGravacaoError("Chave mestra inválida");
  return Buffer.from(hex, "hex");
}

export function novaChave(): Buffer {
  return randomBytes(32);
}

/** Chave da gravação protegida pela chave mestra, presa à ligação (60 bytes: nonce, cifra, tag). */
export function embrulharChave(chave: Buffer, mestra: Buffer, ligacaoId: string): Buffer {
  if (chave.length !== 32) throw new CifraGravacaoError("Chave da gravação inválida");
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", mestra, nonce);
  c.setAAD(Buffer.from(`omni-gravacao:${ligacaoId}`, "utf8"));
  const corpo = Buffer.concat([c.update(chave), c.final()]);
  return Buffer.concat([nonce, corpo, c.getAuthTag()]);
}

export function desembrulharChave(embrulhada: Uint8Array, mestra: Buffer, ligacaoId: string): Buffer {
  const b = Buffer.from(embrulhada);
  if (b.length !== 60) throw new CifraGravacaoError("Chave da gravação inválida");
  try {
    const d = createDecipheriv("aes-256-gcm", mestra, b.subarray(0, 12));
    d.setAAD(Buffer.from(`omni-gravacao:${ligacaoId}`, "utf8"));
    d.setAuthTag(b.subarray(44, 60));
    return Buffer.concat([d.update(b.subarray(12, 44)), d.final()]);
  } catch {
    throw new CifraGravacaoError("Não foi possível abrir a chave da gravação");
  }
}

const blocos = (total: number) => Math.ceil(total / BLOCO);
const tamanhoDoBloco = (i: number, total: number) => Math.min(BLOCO, total - i * BLOCO);

function nonce(i: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
}
function aad(i: number, total: number): Buffer {
  const a = Buffer.alloc(MAGIA.length + 8 + 8 + 1);
  MAGIA.copy(a, 0);
  a.writeBigUInt64BE(BigInt(total), 8);
  a.writeBigUInt64BE(BigInt(i), 16);
  a[24] = i === blocos(total) - 1 ? 1 : 0;
  return a;
}

/** Tamanho do arquivo cifrado para `total` bytes originais. */
export function tamanhoCifrado(total: number): number {
  return CABECALHO + total + blocos(total) * TAG;
}

export function cifrarGravacao(dados: Uint8Array, chave: Buffer): Uint8Array {
  const total = dados.byteLength;
  if (!total) throw new CifraGravacaoError("Gravação vazia");
  const saida = Buffer.alloc(tamanhoCifrado(total));
  MAGIA.copy(saida, 0);
  saida.writeUInt32BE(BLOCO, 8);
  saida.writeBigUInt64BE(BigInt(total), 12);
  let pos = CABECALHO;
  for (let i = 0; i < blocos(total); i += 1) {
    const c = createCipheriv("aes-256-gcm", chave, nonce(i));
    c.setAAD(aad(i, total));
    const parte = dados.subarray(i * BLOCO, i * BLOCO + tamanhoDoBloco(i, total));
    pos += c.update(parte).copy(saida, pos);
    pos += c.final().copy(saida, pos);
    pos += c.getAuthTag().copy(saida, pos);
  }
  return saida;
}

function decifrarBloco(cifrado: Uint8Array, i: number, total: number, chave: Buffer): Buffer {
  const n = tamanhoDoBloco(i, total);
  if (cifrado.byteLength !== n + TAG) throw new CifraGravacaoError("Bloco da gravação com tamanho errado");
  try {
    const d = createDecipheriv("aes-256-gcm", chave, nonce(i));
    d.setAAD(aad(i, total));
    d.setAuthTag(Buffer.from(cifrado.subarray(n)));
    return Buffer.concat([d.update(cifrado.subarray(0, n)), d.final()]);
  } catch {
    throw new CifraGravacaoError("Gravação adulterada ou chave errada");
  }
}

export function decifrarGravacao(arquivo: Uint8Array, chave: Buffer): Uint8Array {
  const b = Buffer.from(arquivo.buffer, arquivo.byteOffset, arquivo.byteLength);
  if (b.length < CABECALHO || !b.subarray(0, 8).equals(MAGIA) || b.readUInt32BE(8) !== BLOCO) throw new CifraGravacaoError("Arquivo de gravação desconhecido");
  const total = Number(b.readBigUInt64BE(12));
  if (b.length !== tamanhoCifrado(total)) throw new CifraGravacaoError("Arquivo de gravação incompleto");
  const partes: Buffer[] = [];
  let pos = CABECALHO;
  for (let i = 0; i < blocos(total); i += 1) {
    const n = tamanhoDoBloco(i, total) + TAG;
    partes.push(decifrarBloco(b.subarray(pos, pos + n), i, total, chave));
    pos += n;
  }
  return Buffer.concat(partes);
}

/** Trecho [inicio, fim] (inclusive) do original → bytes do arquivo cifrado a buscar (Range). */
export function trechoCifrado(inicio: number, fim: number, total: number): { de: number; ate: number; primeiroBloco: number; ultimoBloco: number } {
  if (!(inicio >= 0 && fim >= inicio && fim < total)) throw new CifraGravacaoError("Trecho fora da gravação");
  const primeiroBloco = Math.floor(inicio / BLOCO);
  const ultimoBloco = Math.floor(fim / BLOCO);
  const de = CABECALHO + primeiroBloco * (BLOCO + TAG);
  const ate = CABECALHO + ultimoBloco * (BLOCO + TAG) + tamanhoDoBloco(ultimoBloco, total) + TAG - 1;
  return { de, ate, primeiroBloco, ultimoBloco };
}

/**
 * Decifra, enquanto chega, o trecho cifrado buscado por `trechoCifrado` e entrega só
 * os bytes [inicio, fim] do original. Qualquer bloco adulterado interrompe o envio.
 */
export function decifrarTrecho(cifrado: ReadableStream<Uint8Array>, chave: Buffer, total: number, inicio: number, fim: number): ReadableStream<Uint8Array> {
  const { primeiroBloco, ultimoBloco } = trechoCifrado(inicio, fim, total);
  let i = primeiroBloco;
  let acumulado = Buffer.alloc(0);
  return cifrado.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(pedaco, controle) {
        acumulado = Buffer.concat([acumulado, Buffer.from(pedaco)]);
        while (i <= ultimoBloco) {
          const n = tamanhoDoBloco(i, total) + TAG;
          if (acumulado.length < n) return;
          const claro = decifrarBloco(acumulado.subarray(0, n), i, total, chave);
          acumulado = acumulado.subarray(n);
          const base = i * BLOCO;
          const corte = claro.subarray(Math.max(0, inicio - base), Math.min(claro.length, fim - base + 1));
          if (corte.length) controle.enqueue(new Uint8Array(corte));
          i += 1;
        }
      },
      flush() {
        if (i <= ultimoBloco) throw new CifraGravacaoError("Trecho da gravação incompleto");
      },
    }),
  );
}
