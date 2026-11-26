import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight, ClipboardList, Download, FileText, MessageSquareText, Sparkles } from "lucide-react";
import { useState } from "react";

import { enviarMensagem } from "../../lib/canais-fns.ts";
import { listarRelatoriosDaMissao, type RelatorioDaMissao, type SituacaoRelatorio } from "../../lib/relatorios-fns.ts";
import { FalhaAoCarregar } from "../comum/TentarDeNovo.tsx";
import { Carregando } from "../comum/Carregando.tsx";

/** Abas RDOs e Relatórios técnicos da missão (INSTRUCOES §6.10). Dados do filtroAPP, só leitura. */

export const NOME_DO_TIPO: Record<string, string> = {
  RDO: "Diário de obra",
  RDO_MAINTENANCE: "Diário de manutenção",
  RTP: "Teste de Pressão",
  RLQ: "Limpeza Química",
  RCPU: "Contagem de Partículas e Umidade",
  RLM: "Limpeza Mecânica",
  RLF: "Flushing",
  RLI: "Inibição",
};

const SITUACAO: Record<SituacaoRelatorio, { texto: string; cor: string }> = {
  PENDING: { texto: "Aguardando aprovação", cor: "bg-superficie-2 text-muted" },
  RETURNED: { texto: "Devolvido", cor: "bg-vermelho/10 text-vermelho" },
  APPROVED: { texto: "Aprovado", cor: "bg-azul/10 text-azul" },
  SIGNED: { texto: "Assinado pelo cliente", cor: "bg-floresta-clara text-floresta-texto" },
};

const dataCurta = (d: string) => {
  const [a, m, dia] = d.split("-");
  return `${dia}/${m}/${a}`;
};
const horas = (min: number | null) => {
  if (min === null) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
};
const numero = (r: RelatorioDaMissao) => r.numero ?? (r.sequencia !== null ? String(r.sequencia) : null);
const titulo = (r: RelatorioDaMissao) => {
  const sigla = r.tipo === "RDO_MAINTENANCE" ? "RDO" : r.tipo;
  const n = numero(r);
  // O filtroAPP às vezes já manda a sigla no número ("RDO 147").
  const nome = !n ? sigla : n.toUpperCase().startsWith(sigla) ? n : `${sigla} nº ${n}`;
  return `${nome} de ${dataCurta(r.data)}`;
};

export function useRelatoriosDaMissao(missionId: string) {
  return useQuery({ queryKey: ["relatorios", missionId], queryFn: () => listarRelatoriosDaMissao({ data: { missionId } }), staleTime: 60_000 });
}

function Estado({ q, vazio }: { q: ReturnType<typeof useRelatoriosDaMissao>; vazio?: string }) {
  if (q.isPending) return <Carregando className="p-5" />;
  if (q.isError) return <FalhaAoCarregar mensagem="Não foi possível carregar os relatórios da missão." consulta={q} />;
  return vazio ? <p className="p-5 text-sm text-muted">{vazio}</p> : null;
}

function Situacao({ s }: { s: SituacaoRelatorio }) {
  const x = SITUACAO[s];
  return <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${x.cor}`}>{x.texto}</span>;
}

function Contador({ rotulo, valor, destaque }: { rotulo: string; valor: number; destaque?: boolean }) {
  return (
    <div className="rounded-lg border border-linha bg-superficie px-4 py-3">
      <p className={`text-2xl font-semibold ${destaque ? "text-vermelho" : ""}`}>{valor}</p>
      <p className="text-xs text-muted">{rotulo}</p>
    </div>
  );
}

// ---------------------------------------------------------------- RDOs

export function RdosDaMissao({ missionId }: { missionId: string }) {
  const q = useRelatoriosDaMissao(missionId);
  const [filtro, setFiltro] = useState<"todos" | "atencao">("todos");
  if (!q.data) return <Estado q={q} />;
  const { rdos, veInterno } = q.data;
  if (!rdos.length) return <Estado q={q} vazio="Nenhum RDO ainda. Quando o líder de campo emitir, os RDOs aparecem aqui." />;
  const assinados = rdos.filter((r) => r.situacao === "SIGNED").length;
  const devolvidos = rdos.filter((r) => r.situacao === "RETURNED").length;
  const comPontos = rdos.filter((r) => r.pontosIA?.length).length;
  const lista = filtro === "atencao" ? rdos.filter((r) => r.situacao === "RETURNED" || r.pontosIA?.length) : rdos;
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Contador rotulo="Emitidos" valor={rdos.length} />
        <Contador rotulo="Assinados pelo cliente" valor={assinados} />
        <Contador rotulo="Aguardando assinatura" valor={rdos.length - assinados - devolvidos} />
        <Contador rotulo="Devolvidos" valor={devolvidos} destaque={devolvidos > 0} />
      </div>
      {veInterno && (
        <p className="flex items-start gap-2 rounded-md bg-superficie-2 px-3 py-2 text-sm">
          <Sparkles size={16} aria-hidden className="mt-0.5 shrink-0 text-floresta-texto" />
          <span>
            A IA lê os RDOs todo dia às 7h e pergunta no Interno quando acha algo.{" "}
            {comPontos ? `${comPontos} RDO${comPontos === 1 ? "" : "s"} com pontos apontados.` : "Nenhum ponto apontado até agora."}
          </span>
        </p>
      )}
      {(devolvidos > 0 || comPontos > 0) && (
        <div className="flex gap-1 text-sm" role="group" aria-label="Filtrar RDOs">
          {(["todos", "atencao"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filtro === f}
              onClick={() => setFiltro(f)}
              className={`rounded-md px-3 py-1.5 ${filtro === f ? "bg-floresta text-white" : "text-muted hover:bg-superficie-2"}`}
            >
              {f === "todos" ? "Todos" : "Pedem atenção"}
            </button>
          ))}
        </div>
      )}
      <ul className="space-y-2">
        {lista.map((r) => (
          <CartaoRelatorio key={r.id} r={r} missionId={missionId} podeComentar={veInterno} pdfConfigurado={q.data.pdfConfigurado} />
        ))}
      </ul>
      <p className="text-xs text-muted">O documento completo, as assinaturas e a edição ficam no filtroAPP.</p>
    </div>
  );
}

const VERSAO_PDF: Record<string, string> = { FINAL_ASSINADO: "assinado", ZAPSIGN: "assinado (ZapSign)", MANUAL: "enviado à mão", BASE_APROVADO: "aprovado", CACHE: "gerado" };

/** Ver e baixar o PDF pelo servidor do Omni (spec 038 do filtroAPP). */
function PdfDoRelatorio({ r }: { r: RelatorioDaMissao }) {
  const manutencao = r.tipo === "RDO_MAINTENANCE";
  const docs = manutencao ? r.pdf.anexos : [null];
  if (manutencao && !docs.length) return <p className="text-xs text-muted">Sem documento de manutenção no filtroAPP.</p>;
  const link = "flex items-center gap-1 rounded-md border border-linha px-2.5 py-1 text-xs font-medium hover:bg-superficie-2";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {docs.map((anexo, i) => {
        const base = `/api/relatorios/${encodeURIComponent(r.id)}/pdf${anexo ? `?anexo=${encodeURIComponent(anexo)}` : ""}`;
        const sufixo = docs.length > 1 ? ` ${i + 1}` : "";
        return (
          <span key={anexo ?? "pdf"} className="flex gap-1">
            <a href={base} target="_blank" rel="noreferrer" className={`${link} text-floresta-texto`}>
              <FileText size={14} aria-hidden /> Ver PDF{sufixo}
            </a>
            <a href={`${base}${anexo ? "&" : "?"}baixar=1`} className={link}>
              <Download size={14} aria-hidden /> Baixar
            </a>
          </span>
        );
      })}
      <span className="text-xs text-muted">
        {r.pdf.disponivel === false ? "O filtroAPP ainda não tem o PDF pronto; pode não abrir." : r.pdf.versao ? `PDF ${VERSAO_PDF[r.pdf.versao] ?? r.pdf.versao.toLowerCase()}` : ""}
      </span>
    </div>
  );
}

function CartaoRelatorio({ r, missionId, podeComentar, pdfConfigurado }: { r: RelatorioDaMissao; missionId: string; podeComentar: boolean; pdfConfigurado: boolean }) {
  const [aberto, setAberto] = useState(false);
  const pontos = r.pontosIA ?? [];
  const Seta = aberto ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-lg border border-linha bg-superficie">
      <button type="button" onClick={() => setAberto(!aberto)} aria-expanded={aberto} className="flex w-full items-center gap-3 p-3 text-left hover:bg-superficie-2">
        <Seta size={16} aria-hidden className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{titulo(r)}</span>
          <span className="block text-xs text-muted">
            {[r.tipo === "RDO_MAINTENANCE" ? NOME_DO_TIPO.RDO_MAINTENANCE : null, horas(r.minutos) && `${horas(r.minutos)} trabalhadas`, r.minutosExtra ? `${horas(r.minutosExtra)} de hora extra` : null]
              .filter(Boolean)
              .join(" · ") || "Sem horas informadas"}
          </span>
        </span>
        {pontos.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 rounded-sm bg-lilas/15 px-1.5 py-0.5 text-[11px] font-medium text-lilas" title="Pontos apontados pela IA">
            <Sparkles size={12} aria-hidden /> {pontos.length}
          </span>
        )}
        <Situacao s={r.situacao} />
      </button>
      {aberto && (
        <div className="space-y-3 border-t border-linha p-3 text-sm">
          {r.descricao ? <p className="whitespace-pre-wrap">{r.descricao}</p> : <p className="text-muted">Sem descrição das atividades.</p>}
          {r.minutosExtra ? <p className="text-muted">Motivo da hora extra: {r.motivoExtra?.trim() || "não informado"}</p> : null}
          {pontos.length > 0 && (
            <div className="rounded-md bg-superficie-2 p-3">
              <p className="flex items-center gap-1 rotulo text-muted">
                <Sparkles size={14} aria-hidden /> Apontado pela IA
              </p>
              <ul className="mt-1 ml-4 list-disc space-y-1">
                {pontos.map((p, i) => (
                  <li key={i}>
                    {p.resumo}
                    {p.trecho && <span className="block text-xs text-muted">"{p.trecho}"</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-muted">
            {[
              r.enviadoEm && `Enviado em ${new Date(r.enviadoEm).toLocaleDateString("pt-BR")}`,
              r.devolvidoEm && `devolvido em ${new Date(r.devolvidoEm).toLocaleDateString("pt-BR")}`,
              r.aprovadoEm && `aprovado em ${new Date(r.aprovadoEm).toLocaleDateString("pt-BR")}`,
              r.assinadoEm && `assinado pelo cliente em ${new Date(r.assinadoEm).toLocaleDateString("pt-BR")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {pdfConfigurado && <PdfDoRelatorio r={r} />}
          {podeComentar && <ComentarNoInterno missionId={missionId} sobre={titulo(r)} />}
        </div>
      )}
    </li>
  );
}

function ComentarNoInterno({ missionId, sobre }: { missionId: string; sobre: string }) {
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);
  const qc = useQueryClient();
  const enviar = useMutation({
    mutationFn: () => enviarMensagem({ data: { missionId, channel: "interno", body: `Sobre o ${sobre}:\n${texto.trim()}` } }),
    onSuccess: () => {
      setTexto("");
      setAberto(false);
      void qc.invalidateQueries({ queryKey: ["mensagens", missionId, "interno"] });
    },
  });
  if (!aberto) {
    return (
      <div>
        <button type="button" onClick={() => setAberto(true)} className="flex items-center gap-1.5 text-sm text-floresta-texto hover:underline">
          <MessageSquareText size={16} aria-hidden /> Comentar no Interno
        </button>
        {enviar.isSuccess && <p className="mt-1 text-sm text-floresta-texto">Comentário enviado ao Interno.</p>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="text-muted">Comentário no Interno (o relatório vai citado)</span>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} maxLength={4000} className="mt-1 w-full rounded-md border border-linha bg-superficie p-2" />
      </label>
      {enviar.isError && <p className="text-sm text-vermelho">Não foi possível enviar. Tente de novo.</p>}
      <div className="flex gap-2">
        <button type="button" disabled={!texto.trim() || enviar.isPending} onClick={() => enviar.mutate()} className="rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          Enviar ao Interno
        </button>
        <button type="button" onClick={() => setAberto(false)} className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-superficie-2">
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- relatórios técnicos

export function RelatoriosTecnicos({ missionId }: { missionId: string }) {
  const q = useRelatoriosDaMissao(missionId);
  const [tipo, setTipo] = useState<string | null>(null);
  if (!q.data) return <Estado q={q} />;
  const { tecnicos, veInterno } = q.data;
  if (!tecnicos.length) return <Estado q={q} vazio="Nenhum relatório técnico ainda (RTP, RLQ, RCPU, RLM, RLF, RLI)." />;
  const porTipo = new Map<string, RelatorioDaMissao[]>();
  for (const r of tecnicos) porTipo.set(r.tipo, [...(porTipo.get(r.tipo) ?? []), r]);
  const escolhidos = tipo ? (porTipo.get(tipo) ?? []) : [];

  if (tipo) {
    return (
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <button type="button" onClick={() => setTipo(null)} className="flex items-center gap-1 text-sm text-floresta-texto hover:underline">
          <ArrowLeft size={16} aria-hidden /> Todos os tipos
        </button>
        <h3 className="font-semibold">
          {tipo} · {NOME_DO_TIPO[tipo] ?? "Relatório técnico"} <span className="font-normal text-muted">({escolhidos.length})</span>
        </h3>
        <ul className="space-y-2">
          {escolhidos.map((r) => (
            <CartaoRelatorio key={r.id} r={r} missionId={missionId} podeComentar={veInterno} pdfConfigurado={q.data.pdfConfigurado} />
          ))}
        </ul>
        <p className="text-xs text-muted">O documento completo, as assinaturas e a edição ficam no filtroAPP.</p>
      </div>
    );
  }
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      <ul className="grid gap-2 sm:grid-cols-2">
        {[...porTipo.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([t, lista]) => {
            const assinados = lista.filter((r) => r.situacao === "SIGNED").length;
            const devolvidos = lista.filter((r) => r.situacao === "RETURNED").length;
            return (
              <li key={t}>
                <button type="button" onClick={() => setTipo(t)} className="flex w-full items-start gap-3 rounded-lg border border-linha bg-superficie p-4 text-left hover:bg-superficie-2">
                  <FileText size={20} aria-hidden className="mt-0.5 shrink-0 text-floresta-texto" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      {t} <span className="font-normal text-muted">· {NOME_DO_TIPO[t] ?? "Relatório técnico"}</span>
                    </span>
                    <span className="block text-sm text-muted">
                      {lista.length} relatório{lista.length === 1 ? "" : "s"} · {assinados} assinado{assinados === 1 ? "" : "s"}
                      {devolvidos ? ` · ${devolvidos} devolvido${devolvidos === 1 ? "" : "s"}` : ""} · último em {dataCurta(lista[0]!.data)}
                    </span>
                  </span>
                  <ChevronRight size={16} aria-hidden className="mt-1 shrink-0 text-muted" />
                </button>
              </li>
            );
          })}
      </ul>
      <p className="flex items-center gap-1 text-xs text-muted">
        <ClipboardList size={14} aria-hidden /> Abra um relatório para ver ou baixar o PDF (o documento vem do filtroAPP na hora).
      </p>
    </div>
  );
}
