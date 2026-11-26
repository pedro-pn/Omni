import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, ListPlus, Sparkles, Video } from "lucide-react";

import { listarReunioesDaMissao, pendenciaParaTarefa, type Reuniao, type SituacaoTranscricao } from "../../lib/reunioes-fns.ts";
import { FalhaAoCarregar } from "../comum/TentarDeNovo.tsx";
import { Carregando } from "../comum/Carregando.tsx";

const MOTIVO: Record<string, string> = { numero: "Número da missão", proposta: "Proposta", nf: "Nota fiscal", dominio: "Domínio do cliente" };

const SITUACAO: Record<SituacaoTranscricao, string> = {
  pendente: "Aguardando a transcrição",
  sem_link: "Reunião sem Teams",
  sem_transcricao: "Sem transcrição",
  sem_acesso: "Transcrição fora do alcance do Omni",
  acesso_desligado: "Acesso às transcrições desligado no Teams",
  disponivel: "Transcrição disponível (resumo pela IA desligado)",
  resumida: "Resumo pela IA",
  erro: "Não foi possível resumir",
};

const quando = (r: Reuniao) => {
  const ini = new Date(r.inicio);
  const fim = new Date(r.fim);
  const tz = { timeZone: "America/Sao_Paulo" } as const;
  return `${ini.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", ...tz })} · ${ini.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...tz })}–${fim.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...tz })}`;
};

export function useReunioesDaMissao(missionId: string) {
  return useQuery({ queryKey: ["reunioes", missionId], queryFn: () => listarReunioesDaMissao({ data: { missionId } }) });
}

export function ReunioesDaMissao({ missionId }: { missionId: string }) {
  const q = useReunioesDaMissao(missionId);
  if (q.isPending) return <Carregando className="p-5" />;
  if (q.isError) return <FalhaAoCarregar mensagem="Não foi possível carregar as reuniões da missão." consulta={q} />;
  if (!q.data.podeVer) return <p className="p-5 text-sm text-muted">As reuniões da missão são para a diretoria e os gerentes.</p>;
  const agora = Date.now();
  const proximas = q.data.reunioes.filter((r) => new Date(r.fim).getTime() > agora).reverse();
  const passadas = q.data.reunioes.filter((r) => new Date(r.fim).getTime() <= agora);
  return (
    <div className="flex-1 space-y-5 overflow-y-auto p-5">
      <p className="text-sm text-muted">
        Reuniões das caixas liberadas que citam a missão. A transcrição não fica no Omni: só o resumo feito pela IA, que também vai para o Gerencial.
      </p>
      {!q.data.reunioes.length && <p className="text-sm text-muted">Nenhuma reunião ligada a esta missão nos últimos 30 dias.</p>}
      {proximas.length > 0 && (
        <section className="space-y-2">
          <h3 className="rotulo text-muted">Próximas</h3>
          {proximas.map((r) => (
            <CartaoReuniao key={r.id} r={r} missionId={missionId} />
          ))}
        </section>
      )}
      {passadas.length > 0 && (
        <section className="space-y-2">
          <h3 className="rotulo text-muted">Realizadas</h3>
          {passadas.map((r) => (
            <CartaoReuniao key={r.id} r={r} missionId={missionId} />
          ))}
        </section>
      )}
    </div>
  );
}

function CartaoReuniao({ r, missionId }: { r: Reuniao; missionId: string }) {
  const qc = useQueryClient();
  const tarefa = useMutation({
    mutationFn: (indice: number) => pendenciaParaTarefa({ data: { missionId, meetingId: r.id, indice } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["reunioes", missionId] });
      void qc.invalidateQueries({ queryKey: ["tarefas"] });
    },
  });
  const encerrada = new Date(r.fim).getTime() <= Date.now();
  return (
    <article className="rounded-lg border border-linha bg-superficie p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 font-semibold">
            <Video size={16} aria-hidden className="shrink-0 text-floresta-texto" />
            <span className="truncate">{r.titulo}</span>
          </h4>
          <p className="text-sm text-muted">
            {quando(r)}
            {r.organizador ? ` · organizada por ${r.organizador}` : ""}
          </p>
        </div>
        {r.linkTeams && !encerrada && (
          <a href={r.linkTeams} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-md border border-linha px-3 py-1.5 text-sm font-medium hover:bg-superficie-2">
            Entrar no Teams <ExternalLink size={14} aria-hidden />
          </a>
        )}
      </header>
      <p className="mt-2 text-xs text-muted">
        {r.participantes.length} participante{r.participantes.length === 1 ? "" : "s"}
        {r.participantes.length ? `: ${r.participantes.slice(0, 6).map((p) => p.nome || p.endereco).join(", ")}${r.participantes.length > 6 ? "…" : ""}` : ""}
      </p>
      <p className="mt-1 text-xs text-muted">Ligada por: {r.motivos.map((m) => `${MOTIVO[m.motivo] ?? m.motivo} (${m.detalhe})`).join(" · ")}</p>

      {encerrada && r.linkTeams && !r.resumo && <p className="mt-3 text-sm text-muted">{SITUACAO[r.transcricao]}</p>}
      {r.resumo && (
        <div className="mt-3 space-y-3 rounded-md bg-superficie-2 p-3 text-sm">
          <p className="flex items-center gap-1 rotulo text-muted">
            <Sparkles size={14} aria-hidden /> Resumo pela IA
          </p>
          <p>{r.resumo.texto}</p>
          {r.resumo.decisoes.length > 0 && (
            <div>
              <p className="font-medium">Decisões</p>
              <ul className="ml-4 list-disc">
                {r.resumo.decisoes.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {r.resumo.pendencias.length > 0 && (
            <div>
              <p className="font-medium">Pendências</p>
              <ul className="space-y-1.5">
                {r.resumo.pendencias.map((p, i) => (
                  <li key={p.tarefaId} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {p.descricao}
                      {p.responsavel && <span className="text-muted"> — {p.responsavel}</span>}
                      {p.prazo && <span className="text-muted"> ({p.prazo})</span>}
                    </span>
                    {p.virouTarefa ? (
                      <span className="flex items-center gap-1 text-xs text-floresta-texto">
                        <CheckCircle2 size={14} aria-hidden /> Virou tarefa
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={tarefa.isPending}
                        onClick={() => tarefa.mutate(i)}
                        className="flex items-center gap-1 rounded-md border border-linha bg-superficie px-2 py-1 text-xs font-medium hover:bg-superficie-2 disabled:opacity-60"
                      >
                        <ListPlus size={14} aria-hidden /> Criar tarefa
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tarefa.isError && <p className="text-sm text-vermelho">{(tarefa.error as Error).message}</p>}
          <p className="text-xs text-muted">Resumo gerado pela IA a partir da transcrição do Teams. Confira antes de agir.</p>
        </div>
      )}
    </article>
  );
}
