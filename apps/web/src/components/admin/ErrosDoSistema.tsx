import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug, Check, CircleCheck, DatabaseBackup, Server } from "lucide-react";

import { errosDoSistema, marcarErroVisto, type ErroDoSistemaNaTela } from "../../lib/erros-sistema-fns.ts";
import { Aviso, botaoSecundario, mensagemDeErro } from "./ui.tsx";

const quando = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

const ORIGEM: Record<ErroDoSistemaNaTela["origem"], { rotulo: string; Icone: typeof Bug }> = {
  web: { rotulo: "Web", Icone: Bug },
  worker: { rotulo: "Worker", Icone: Server },
  operacao: { rotulo: "Backup", Icone: DatabaseBackup },
};

/**
 * Erros do sistema (E09): o que falhou no web, no worker e no backup, agrupado. Quem é admin
 * recebe no sino e no celular quando um erro aparece (e de novo se ele voltar depois de 6 h).
 * Os textos já chegam sem e-mail, CPF, telefone, token nem consulta ao banco.
 */
export function ErrosDoSistema() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "erros"], queryFn: () => errosDoSistema() });
  const visto = useMutation({
    mutationFn: (id: string) => marcarErroVisto({ data: { id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "erros"] }),
  });
  if (q.isPending) return <p className="text-muted">Carregando…</p>;
  if (q.isError) return <Aviso tipo="erro">{mensagemDeErro(q.error)}</Aviso>;
  const erros = q.data;
  const abertos = erros.filter((e) => !e.vistoEm).length;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-linha bg-superficie p-4 text-sm">
        <p className="font-medium">Como funciona</p>
        <p className="mt-1 text-muted">
          Todo erro inesperado do Omni (telas, rotas e tarefas automáticas) e todo problema do backup fica aqui, agrupado. Quem administra recebe um aviso
          no sino e no celular quando um erro aparece, e de novo se ele voltar depois de 6 horas. Marque como visto depois de resolver: se acontecer de
          novo, ele volta para a lista.
        </p>
      </div>
      {visto.isError && <Aviso tipo="erro">{mensagemDeErro(visto.error)}</Aviso>}
      {!erros.length ? (
        <p className="flex items-center gap-2 text-muted">
          <CircleCheck size={18} aria-hidden /> Nenhum erro registrado.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">{abertos ? `${abertos} erro${abertos === 1 ? "" : "s"} sem revisão.` : "Todos os erros foram vistos."}</p>
          <ul className="divide-y divide-linha rounded-lg border border-linha bg-superficie">
            {erros.map((e) => {
              const { rotulo, Icone } = ORIGEM[e.origem];
              return (
                <li key={e.id} className={`flex flex-wrap items-start gap-3 p-4 ${e.vistoEm ? "" : "bg-vermelho/5"}`}>
                  <Icone size={18} aria-hidden className={`mt-0.5 ${e.vistoEm ? "text-muted" : "text-vermelho"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {rotulo} · <span className="break-all">{e.local}</span>
                    </p>
                    <p className="text-sm break-words">
                      <span className="font-mono text-xs">{e.nome}</span> {e.mensagem}
                    </p>
                    <p className="text-xs text-muted">
                      {e.ocorrencias} {e.ocorrencias === 1 ? "vez" : "vezes"} · primeira em {quando(e.primeiraVez)} · última em {quando(e.ultimaVez)}
                      {e.versao ? ` · versão ${e.versao.slice(0, 7)}` : ""}
                      {e.vistoEm ? ` · visto por ${e.vistoPor ?? "—"} em ${quando(e.vistoEm)}` : ""}
                    </p>
                    {e.detalhe && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted">Ver a pilha</summary>
                        <pre className="mt-1 max-h-64 overflow-auto rounded bg-fundo p-2 text-xs whitespace-pre-wrap">{e.detalhe}</pre>
                      </details>
                    )}
                  </div>
                  {!e.vistoEm && (
                    <button type="button" disabled={visto.isPending} onClick={() => visto.mutate(e.id)} className={`${botaoSecundario} flex items-center gap-1`}>
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
