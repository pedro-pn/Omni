import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { getEnv } from "./env.ts";

/**
 * Cifra simétrica (AES-256-GCM) com chaves derivadas do AUTH_SECRET por HKDF.
 * Cada uso tem o seu `proposito`, então um valor cifrado para um fim não abre
 * em outro. Formato: iv (12) | tag (16) | corpo.
 */

function chave(proposito: string): Buffer {
  return Buffer.from(hkdfSync("sha256", getEnv().AUTH_SECRET, "omni", proposito, 32));
}

export function cifrar(texto: string, proposito: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chave(proposito), iv);
  const corpo = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), corpo]);
}

/** Lança erro se o valor foi alterado, é de outro propósito ou a chave mudou. */
export function decifrar(bytes: Buffer, proposito: string): string {
  if (bytes.length < 29) throw new Error("valor cifrado inválido");
  const decipher = createDecipheriv("aes-256-gcm", chave(proposito), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

/** Objeto → texto base64url cifrado (para cookies). */
export function selar(valor: unknown, proposito: string): string {
  return cifrar(JSON.stringify(valor), proposito).toString("base64url");
}

/** Texto do cookie → objeto. `null` se ausente, adulterado ou grande demais. */
export function abrir<T>(texto: string | undefined, proposito: string): T | null {
  if (!texto || texto.length > 4096) return null;
  try {
    return JSON.parse(decifrar(Buffer.from(texto, "base64url"), proposito)) as T;
  } catch {
    return null;
  }
}
