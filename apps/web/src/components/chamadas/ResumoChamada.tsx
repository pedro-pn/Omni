import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileText, ListPlus, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { RegistrarNoPrisma } from "../prisma/NoPrisma.tsx";
import { pedirResumoChamada, pendenciaDaChamadaParaTarefa, transcricaoDaChamada, type ResumoChamada as Resumo } from "../../lib/chamadas-fns.ts";

/** Transcrição guardada da ligação (0062): carrega só quando abre (pode ser longa). */
function Transcricao({ callId }: { callId: string }) {
  const [aberta, setAberta] = useState(false);
  const [copiou, setCopiou] = useState(false);
  const q = useQuery({ queryKey: ["chamadas", "transcricao", callId], queryFn: () => transcricaoDaChamada({ data: { callId } }), enabled: aberta, staleTime: Infinity });
  return (
    <div>
      <button type="button" onClick={() => setAberta(!aberta)} aria-expanded={aberta} className="flex items-center gap-1 text-xs font-medium text-floresta-texto hover:underline">
        <FileText size={14} aria-hidden /> {aberta ? "Esconder a transcrição" : "Ver a transcrição"}
      </button>
      {aberta && (
        <div className="mt-1.5 rounded-md border border-linha bg-superficie p-2">
          {q.isPending && <p className="text-xs text-muted">Carregando…</p>}
          {q.isError && <p className="text-xs text-vermelho">Não foi possível carregar a transcrição.</p>}
          {q.data && (
            <>
              <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm">{q.data.texto ?? "Sem transcrição."}</p>
              {q.data.texto && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(q.data.texto ?? "").then(() => {
                      setCopiou(true);
                      setTimeout(() => setCopiou(false), 2000);
                    });
                  }}
                  className="mt-1.5 flex items-center gap-1 rounded-md border border-linha px-2 py-0.5 text-xs hover:bg-superficie-2"
                >
                  {copiou ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />} {copiou ? "Copiada" : "Copiar"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Resumo e transcrição da ligação gravada pela IA (job chamadas-resumo), só quando o
 * dono pede ("Resumir com IA"). Aparece para quem já ouve a gravação; cada
 * pendência vira tarefa na caixa pessoal (sem duplicar).
 */
export function ResumoChamada({
  callId,
  resumo,
  situacao,
  compacto = false,
  podePedir = false,
  podeRegistrar = false,
  temTranscricao = false,
}: {
  callId: string;
  /** A transcrição está guardada (0062). */
  temTranscricao?: boolean;
  resumo: Resumo | null;
  situacao: "pendente" | "resumida" | "sem_fala" | "erro" | null;
  compacto?: boolean;
  /** Dono da gravação, com o áudio ainda disponível. */
  podePedir?: boolean;
  /** Dono da ligação: pode registrar no Prisma como feedback. */
  podeRegistrar?: boolean;
}) {
  const [aberto, setAberto] = useState(!compacto);
  const [criadas, setCriadas] = useState<Set<number>>(new Set());
  const qc = useQueryClient();
  const tarefa = useMutation({
    mutationFn: (indice: number) => pendenciaDaChamadaParaTarefa({ data: { callId, indice } }),
    onSuccess: (_r, indice) => {
      setCriadas((s) => new Set(s).add(indice));
      void qc.invalidateQueries({ queryKey: ["tarefas"] });
    },
  });
  const pedir = useMutation({
    mutationFn: () => pedirResumoChamada({ data: { callId } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["chamadas"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp", "mensagens"] });
    },
  });
  // Enquanto transcreve e resume, confere de novo a cada 15 s (até chegar o resumo e a transcrição).
  const pronto = Boolean(resumo && temTranscricao) || situacao === "sem_fala";
  const pendente = situacao === "pendente" || (pedir.isSuccess && !pronto);
  useEffect(() => {
    if (!pendente || pronto) return;
    const t = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["chamadas"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp", "mensagens"] });
    }, 15_000);
    return () => clearInterval(t);
  }, [pendente, pronto, qc]);
  if (!resumo) {
    if (pendente)
      return (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Transcrevendo e resumindo… leva cerca de 1 minuto.
        </p>
      );
    if (situacao === "sem_fala")
      return (
        <div className="space-y-1">
          <p className="text-xs text-muted">Resumo: a ligação não teve fala suficiente.</p>
          {temTranscricao && <Transcricao callId={callId} />}
        </div>
      );
    if (!podePedir) return situacao === "erro" ? <p className="text-xs text-muted">Não foi possível resumir esta ligação.</p> : null;
    return (
      <div className="flex flex-col items-start gap-1">
        {situacao === "erro" && <p className="text-xs text-muted">Não foi possível resumir esta ligação.</p>}
        <button
          type="button"
          disabled={pedir.isPending}
          onClick={() => pedir.mutate()}
          title="A gravação vai à OpenAI para transcrever; o Omni guarda a transcrição e o resumo."
          className="flex items-center gap-1.5 rounded-md border border-linha bg-superficie px-2.5 py-1 text-xs font-medium text-floresta-texto hover:bg-superficie-2"
        >
          <Sparkles size={14} aria-hidden /> {situacao === "erro" ? "Tentar resumir de novo" : "Resumir com IA"}
        </button>
        {pedir.isError && <p className="text-xs text-vermelho">{pedir.error instanceof Error ? pedir.error.message : "Não foi possível pedir o resumo."}</p>}
      </div>
    );
  }
  return (
    <div className="w-full max-w-md rounded-md bg-superficie-2 p-3 text-left text-sm">
      <button type="button" onClick={() => setAberto(!aberto)} aria-expanded={aberto} className="flex items-center gap-1 rotulo text-muted hover:text-ink">
        <Sparkles size={14} aria-hidden /> Resumo pela IA {compacto && !aberto ? "· ver" : ""}
      </button>
      {aberto && (
        <div className="mt-1 space-y-2">
          <p>{resumo.texto}</p>
          {resumo.decisoes.length > 0 && (
            <div>
              <p className="font-medium">Combinado</p>
              <ul className="ml-4 list-disc">
                {resumo.decisoes.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {resumo.pendencias.length > 0 && (
            <div>
              <p className="font-medium">Pendências</p>
              <ul className="space-y-1">
                {resumo.pendencias.map((p, i) => (
                  <li key={i} className="flex items-start justify-between gap-2">
                    <span>
                      {p.descricao}
                      {(p.responsavel || p.prazo) && <span className="block text-xs text-muted">{[p.responsavel, p.prazo].filter(Boolean).join(" · ")}</span>}
                    </span>
                    {criadas.has(i) ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-floresta-texto">
                        <Check size={14} aria-hidden /> Na sua lista
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={tarefa.isPending}
                        onClick={() => tarefa.mutate(i)}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-linha px-2 py-0.5 text-xs hover:bg-superficie"
                      >
                        <ListPlus size={14} aria-hidden /> Virar tarefa
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {temTranscricao ? (
            <Transcricao callId={callId} />
          ) : (
            podePedir &&
            situacao === "resumida" && (
              // Resumida antes de a transcrição ser guardada: transcreve (e resume) de novo.
              <button
                type="button"
                disabled={pedir.isPending || pendente}
                onClick={() => pedir.mutate()}
                className="flex items-center gap-1 text-xs font-medium text-floresta-texto hover:underline disabled:opacity-60"
              >
                <FileText size={14} aria-hidden /> {pendente ? "Transcrevendo…" : "Transcrever de novo (para guardar a transcrição)"}
              </button>
            )
          )}
          {podeRegistrar && <RegistrarNoPrisma origem="chamada" id={callId} />}
          <p className="text-[11px] text-muted">A transcrição e o resumo ficam junto da gravação; excluir a gravação apaga os dois.</p>
        </div>
      )}
    </div>
  );
}
