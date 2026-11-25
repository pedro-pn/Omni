import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Gravação de mensagem de voz no navegador (MediaRecorder). O Chrome grava em
 * WebM/Opus, o Firefox em OGG/Opus e o Safari em MP4/AAC; o servidor de WhatsApp
 * converte para a mensagem de voz do WhatsApp (OGG/Opus).
 */

/** Teto de uma mensagem de voz (a 32 kbit/s, bem abaixo dos 16 MB do envio). */
export const MAX_SEGUNDOS_VOZ = 30 * 60;

type Gravacao = { rec: MediaRecorder; stream: MediaStream; partes: Blob[]; timer: number };

export function useGravador() {
  const [gravando, setGravando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [erro, setErro] = useState<string | null>(null);
  const atual = useRef<Gravacao | null>(null);

  const limpar = useCallback(() => {
    const g = atual.current;
    atual.current = null;
    if (g) {
      clearInterval(g.timer);
      g.stream.getTracks().forEach((t) => t.stop());
    }
    setGravando(false);
    setSegundos(0);
  }, []);

  // Saiu da conversa no meio da gravação: descarta e solta o microfone.
  useEffect(
    () => () => {
      const g = atual.current;
      if (g) {
        g.rec.onstop = null;
        if (g.rec.state !== "inactive") g.rec.stop();
      }
      limpar();
    },
    [limpar],
  );

  const iniciar = useCallback(async () => {
    setErro(null);
    if (atual.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErro("Este navegador não grava áudio.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setErro("Permita o uso do microfone para gravar.");
      return;
    }
    const tipo = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo, audioBitsPerSecond: 32_000 } : undefined);
    const partes: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) partes.push(e.data);
    };
    rec.start(1000);
    const inicio = Date.now();
    const timer = window.setInterval(() => setSegundos(Math.floor((Date.now() - inicio) / 1000)), 250);
    atual.current = { rec, stream, partes, timer };
    setGravando(true);
  }, []);

  /** Termina e devolve o arquivo (null se não gravou nada). */
  const terminar = useCallback(
    () =>
      new Promise<File | null>((resolve) => {
        const g = atual.current;
        if (!g) return resolve(null);
        g.rec.onstop = () => {
          const tipo = (g.rec.mimeType || "audio/webm").split(";")[0]!.trim();
          const blob = new Blob(g.partes, { type: tipo });
          limpar();
          resolve(blob.size ? new File([blob], `voz.${tipo.split("/")[1] ?? "webm"}`, { type: tipo }) : null);
        };
        if (g.rec.state !== "inactive") g.rec.stop();
        else g.rec.onstop(new Event("stop"));
      }),
    [limpar],
  );

  const cancelar = useCallback(() => {
    const g = atual.current;
    if (g) {
      g.rec.onstop = null;
      if (g.rec.state !== "inactive") g.rec.stop();
    }
    limpar();
  }, [limpar]);

  return { gravando, segundos, erro, iniciar, terminar, cancelar };
}

export const relogio = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
