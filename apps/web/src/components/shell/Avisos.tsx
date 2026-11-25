import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, AtSign, Bell, BellRing, CheckCircle2, MessageSquare, PhoneMissed, ShieldAlert, Siren, SmilePlus, Sparkles, UserPlus } from "lucide-react";
import { useState } from "react";

import { listarAvisos, marcarAvisosLidos, type Aviso } from "../../lib/avisos-fns.ts";

/** O sino: contador de não lidos e a lista dos avisos. Atualiza pelo SSE (evento "aviso"). */

const ICONE: Record<Aviso["tipo"], typeof Bell> = {
  tarefa_atribuida: UserPlus,
  tarefa_concluida: CheckCircle2,
  tarefa_comentario: MessageSquare,
  tarefa_lembrete: AlarmClock,
  tarefa_mencao: AtSign,
  tarefa_reacao: SmilePlus,
  ia_alerta: Siren,
  ia_pergunta: Sparkles,
  teste_push: BellRing,
  chamada_perdida: PhoneMissed,
  risco: ShieldAlert,
};

function haQuanto(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
}

export function SinoAvisos({
  onAbrirTarefa,
  onAbrirMissao,
  onAbrirChamadas,
}: {
  onAbrirTarefa: (id: string) => void;
  onAbrirMissao: (id: string) => void;
  onAbrirChamadas: () => void;
}) {
  const queryClient = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const avisos = useQuery({ queryKey: ["avisos"], queryFn: () => listarAvisos(), refetchInterval: 5 * 60_000 });
  const marcar = useMutation({
    mutationFn: (id?: string) => marcarAvisosLidos({ data: { id } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["avisos"] }),
  });
  const naoLidos = avisos.data?.naoLidos ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-label={naoLidos ? `Avisos, ${naoLidos} não lidos` : "Avisos"}
        title="Avisos"
        className={`relative flex size-11 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white ${aberto ? "bg-white/15 text-white" : ""}`}
      >
        <Bell size={22} strokeWidth={1.9} />
        {naoLidos > 0 && (
          <span className="absolute right-1 top-1 min-w-4 rounded-full bg-vermelho px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {naoLidos > 99 ? "99+" : naoLidos}
          </span>
        )}
      </button>
      {aberto && (
        <div
          role="dialog"
          aria-label="Avisos"
          className="fixed inset-x-2 bottom-16 z-20 flex max-h-[70dvh] flex-col rounded-lg border border-linha bg-superficie text-ink shadow-lg md:absolute md:inset-x-auto md:bottom-0 md:left-12 md:w-96"
        >
          <header className="flex items-center justify-between gap-2 border-b border-linha px-4 py-3">
            <h2 className="font-semibold">Avisos</h2>
            <div className="flex items-center gap-3 text-sm">
              {naoLidos > 0 && (
                <button type="button" onClick={() => marcar.mutate(undefined)} className="text-floresta-texto underline">
                  Marcar todos como lidos
                </button>
              )}
              <button type="button" onClick={() => setAberto(false)} className="rounded-md px-1 hover:bg-superficie-2" aria-label="Fechar avisos">
                ✕
              </button>
            </div>
          </header>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {avisos.data?.avisos.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">Nenhum aviso por enquanto.</li>}
            {avisos.data?.avisos.map((a) => {
              const Icone = ICONE[a.tipo];
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!a.lido) marcar.mutate(a.id);
                      if (a.tarefaId) {
                        onAbrirTarefa(a.tarefaId);
                        setAberto(false);
                      } else if (a.missaoId) {
                        onAbrirMissao(a.missaoId);
                        setAberto(false);
                      } else if (a.tipo === "chamada_perdida") {
                        onAbrirChamadas();
                        setAberto(false);
                      } else if (a.tipo === "risco") {
                        // Alerta de risco: a lista fica na Administração → Segurança.
                        window.location.href = "/admin?aba=seguranca";
                      }
                    }}
                    className={`flex w-full gap-3 border-b border-linha px-4 py-3 text-left hover:bg-superficie-2 ${a.lido ? "" : "bg-floresta-clara"}`}
                  >
                    <Icone size={18} className="mt-0.5 shrink-0 text-floresta-texto" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${a.lido ? "" : "font-medium"}`}>{a.titulo}</span>
                      {a.texto && <span className="block truncate text-sm text-muted">{a.texto}</span>}
                      <span className="text-xs text-muted">{haQuanto(a.em)}</span>
                    </span>
                    {!a.lido && <span className="sr-only">não lido</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
