import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Conversões de áudio das gravações com o ffmpeg (imagem do worker: apk ffmpeg).
 * Arquivos temporários numa pasta própria, apagada no fim; nada vai para o log.
 */
async function converter(entrada: Uint8Array, extEntrada: string, extSaida: string, args: string[], ffmpeg: string): Promise<Uint8Array> {
  const pasta = await mkdtemp(join(tmpdir(), "omni-gravacao-"));
  try {
    const de = join(pasta, `entrada.${extEntrada}`);
    const para = join(pasta, `saida.${extSaida}`);
    await writeFile(de, entrada, { mode: 0o600 });
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", de, ...args, para], { timeout: 15 * 60_000, maxBuffer: 1024 * 1024 });
    const saida = new Uint8Array(await readFile(para));
    if (saida.byteLength < 64) throw new Error("conversão vazia");
    return saida;
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

/** WAV estéreo da gravação → M4A (AAC 48 kbps), os dois lados preservados; pronto para tocar enquanto baixa. */
export function wavParaM4a(wav: Uint8Array, ffmpeg = "ffmpeg"): Promise<Uint8Array> {
  return converter(wav, "wav", "m4a", ["-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart"], ffmpeg);
}

/** M4A do SharePoint → WAV mono 16 kHz (para a transcrição do resumo). */
export function m4aParaWavMono(m4a: Uint8Array, ffmpeg = "ffmpeg"): Promise<Uint8Array> {
  return converter(m4a, "m4a", "wav", ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"], ffmpeg);
}

export async function ffmpegDisponivel(ffmpeg = "ffmpeg"): Promise<boolean> {
  try {
    await exec(ffmpeg, ["-version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
