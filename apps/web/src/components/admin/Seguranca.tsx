import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Send, ShieldCheck } from "lucide-react";

import { alertasDeRisco, marcarAlertaVisto } from "../../lib/seguranca-fns.ts";
import { Aviso, botaoSecundario, mensagemDeErro } from "./ui.tsx";

const ORIGEM: Record<string, string> = {
  sharepoint: "pastas do SharePoint",
  anexo_email_missao: "anexos de e-mails das missões",
  anexo_minha_caixa: "anexos da própria caixa",
  relatorio_pdf: "PDFs de relatórios",
  gravacao: "gravações de ligações",
  arquivo_canal: "arquivos do Interno/Gerencial",
};
const quando = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/**
 * Alertas de risco (Fase 11): volume fora do comum de downloads ou de arquivos
 * enviados para fora da empresa. Quem administra e a diretoria recebem no sino;
 * aqui fica a lista dos últimos 90 dias.
 */
export function Seguranca() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "riscos"], queryFn: () => alertasDeRisco() });
  const visto = useMutation({
    mutationFn: (id: string) => marcarAlertaVisto({ data: { id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "riscos"] }),
  });
  if (q.isPending) return <p className="text-muted">Carregando…</p>;
  if (q.isError) return <Aviso tipo="erro">{mensagemDeErro(q.error)}</Aviso>;
  const { alertas, limites } = q.data;
  const abertos = alertas.filter((a) => !a.vistoEm).length;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-linha bg-superficie p-4 text-sm">
        <p className="font-medium">Como funciona</p>
        <p className="mt-1 text-muted">
          A cada 10 minutos o Omni confere, por pessoa, os downloads de arquivos (pastas do SharePoint, anexos de e-mail, PDFs, gravações e arquivos do
          Interno/Gerencial) e os arquivos enviados para fora da empresa (e-mail com anexo para outro domínio e arquivos pelo WhatsApp). Alerta quando passa
          de {limites.downloadsPorHora} arquivos baixados em uma hora ou {limites.downloadsPorDia} em um dia, ou de {limites.enviosPorHora} arquivos
          (ou {Math.round(limites.bytesEnviadosPorHora / 1024 ** 2)} MB) enviados para fora em uma hora. Todos estão no termo de uso.
        </p>
      </div>
      {visto.isError && <Aviso tipo="erro">{mensagemDeErro(visto.error)}</Aviso>}
      {!alertas.length ? (
        <p className="flex items-center gap-2 text-muted">
          <ShieldCheck size={18} aria-hidden /> Nenhum alerta nos últimos 90 dias.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">{abertos ? `${abertos} alerta${abertos === 1 ? "" : "s"} sem revisão.` : "Todos os alertas foram vistos."}</p>
          <ul className="divide-y divide-linha rounded-lg border border-linha bg-superficie">
            {alertas.map((a) => {
              const origens = a.detalhes.origens ?? {};
              return (
                <li key={a.id} className={`flex flex-wrap items-start gap-3 p-4 ${a.vistoEm ? "" : "bg-vermelho/5"}`}>
                  {a.tipo === "downloads_em_massa" ? (
                    <Download size={18} aria-hidden className="mt-0.5 text-vermelho" />
                  ) : (
                    <Send size={18} aria-hidden className="mt-0.5 text-vermelho" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {a.tipo === "downloads_em_massa" ? "Download em massa" : "Envio de arquivos para fora"} · {a.pessoa}
                    </p>
                    <p className="text-sm">{a.motivo}</p>
                    {Object.keys(origens).length > 0 && (
                      <p className="text-xs text-muted">
                        Na última hora: {Object.entries(origens).map(([o, n]) => `${n} de ${ORIGEM[o] ?? o}`).join(", ")}
                      </p>
                    )}
                    <p className="text-xs text-muted">
                      {quando(a.em)}
                      {a.vistoEm ? ` · visto por ${a.vistoPor ?? "—"} em ${quando(a.vistoEm)}` : ""}
                    </p>
                  </div>
                  {!a.vistoEm && (
                    <button type="button" disabled={visto.isPending} onClick={() => visto.mutate(a.id)} className={`${botaoSecundario} flex items-center gap-1`}>
                      <Check size={14} aria-hidden /> Marcar como visto
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
