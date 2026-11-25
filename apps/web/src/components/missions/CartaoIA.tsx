import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";

import type { Mensagem, PerguntaIA } from "../../lib/canais-fns.ts";
import { mudarAlerta, responderAlerta } from "../../lib/alertas-fns.ts";
import { responderPergunta } from "../../lib/ia-fns.ts";

const horario = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const dataBr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

const DESCARGA: Record<NonNullable<PerguntaIA["descarga"]>["status"], string> = {
  pendente: "Enviando a confirmação de descarga ao filtroAPP…",
  enviado: "Descarga confirmada no filtroAPP.",
  simulado: "Simulação: o filtroAPP aceitaria a confirmação de descarga, mas nada foi gravado (ambiente de teste).",
  ensaio: "Descarga registrada só no Omni (escrita no filtroAPP desligada neste ambiente).",
  falhou: "Não foi possível registrar no filtroAPP. Veja o aviso abaixo.",
};

const DESVIO: Record<NonNullable<PerguntaIA["desvio"]>["status"], (n: string | null) => string> = {
  pendente: () => "Desvio sendo aberto na Qualidade…",
  enviado: (n) => `Desvio ${n ?? ""} aberto na Qualidade do filtroAPP.`,
  simulado: () => "Simulação: o filtroAPP aceitaria o desvio, mas nada foi gravado (ambiente de teste).",
  ensaio: () => "Desvio registrado só no Omni (escrita no filtroAPP desligada neste ambiente).",
  falhou: () => "Não foi possível abrir o desvio na Qualidade. Veja o aviso abaixo.",
};

function Respostas({ pergunta, missionId }: { pergunta: PerguntaIA; missionId: string }) {
  const queryClient = useQueryClient();
  const [escolhida, setEscolhida] = useState<PerguntaIA["opcoes"][number] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const responder = useMutation({
    mutationFn: (v: { opcao: string; nova_data?: string; motivo?: string; detalhe?: string }) =>
      responderPergunta({ data: { questionId: pergunta.id, ...v } }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(e instanceof Error && e.message ? e.message : "Não foi possível responder. Tente de novo."),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, "interno"] });
      void queryClient.invalidateQueries({ queryKey: ["agenda-ia", missionId] });
    },
  });

  const escolher = (o: PerguntaIA["opcoes"][number]) => {
    if (o.pede.length === 0) responder.mutate({ opcao: o.id });
    else setEscolhida(o);
  };

  const enviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    responder.mutate({
      opcao: escolhida!.id,
      ...Object.fromEntries(escolhida!.pede.map((campo) => [campo, String(f.get(campo))])),
    });
  };

  return (
    <div className="mt-2">
      {!escolhida ? (
        <div className="flex flex-wrap gap-2">
          {pergunta.opcoes.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => escolher(o)}
              disabled={responder.isPending}
              className="rounded-md border border-floresta px-3 py-1.5 text-sm font-medium text-floresta-texto hover:bg-floresta-clara disabled:opacity-60"
            >
              {o.rotulo}
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={enviar} className="grid gap-2 rounded-md bg-superficie-2 p-3 text-sm">
          <p className="font-medium">{escolhida.rotulo}</p>
          {escolhida.pede.includes("nova_data") && (
            <label className="grid gap-1">
              {escolhida.rotulos.nova_data ?? "Nova data"}
              <input type="date" name="nova_data" required min={hoje()} className="rounded-md border border-linha bg-superficie px-2 py-1.5" />
            </label>
          )}
          {escolhida.pede.includes("motivo") && (
            <label className="grid gap-1">
              {escolhida.rotulos.motivo ?? "Motivo"}
              <textarea name="motivo" required minLength={3} maxLength={1000} rows={2} className="rounded-md border border-linha bg-superficie px-2 py-1.5" />
            </label>
          )}
          {escolhida.pede.includes("detalhe") && (
            <label className="grid gap-1">
              {escolhida.rotulos.detalhe ?? "Detalhe"}
              <textarea name="detalhe" required minLength={3} maxLength={2000} rows={3} className="rounded-md border border-linha bg-superficie px-2 py-1.5" />
            </label>
          )}
          {escolhida.abreDesvio && (
            <p className="text-xs text-muted">Esta resposta abre um desvio na Qualidade e avisa a Qualidade e o gestor de contrato.</p>
          )}
          {escolhida.criaTarefa && <p className="text-xs text-muted">Esta resposta cria uma tarefa para você na missão, com a data informada.</p>}
          {escolhida.registraDescarga && <p className="text-xs text-muted">Esta resposta registra a descarga no filtroAPP em seu nome.</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={responder.isPending} className="rounded-md bg-floresta px-3 py-1.5 font-medium text-white hover:bg-floresta-escura">
              Enviar resposta
            </button>
            <button type="button" onClick={() => setEscolhida(null)} className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie">
              Voltar
            </button>
          </div>
        </form>
      )}
      {erro && (
        <p role="alert" className="mt-2 text-sm text-vermelho">
          {erro}
        </p>
      )}
    </div>
  );
}

const STATUS_ALERTA = { rascunho: "Aguardando ativação", ativo: "Alerta ativo", pausado: "Alerta pausado", cancelado: "Alerta cancelado" } as const;
const RESPOSTA_DISPARO = {
  nao_veio: "realmente não veio nesse período (sigo vigiando)",
  cobrar: "vai cobrar o líder de campo (virou tarefa)",
  veio: "veio, mas a IA não encontrou",
} as const;

/** Cartão "entendi assim" de um alerta pedido à IA: ativar ou cancelar (quem pediu ou a diretoria). */
function AcoesDoAlerta({ alerta, missionId }: { alerta: NonNullable<Mensagem["alerta"]>; missionId: string }) {
  const queryClient = useQueryClient();
  const mudar = useMutation({
    mutationFn: (status: "ativo" | "pausado" | "cancelado") => mudarAlerta({ data: { alertId: alerta.id, status } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId] });
      void queryClient.invalidateQueries({ queryKey: ["alertas", missionId] });
    },
  });
  return (
    <div className="mt-2 text-sm">
      <p className="text-xs font-medium text-floresta-texto">{STATUS_ALERTA[alerta.status]}</p>
      {alerta.podeMudar && alerta.status !== "cancelado" && (
        <div className="mt-1 flex flex-wrap gap-2">
          {alerta.status !== "ativo" && (
            <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate("ativo")} className="rounded-md bg-floresta px-3 py-1 font-medium text-white">
              {alerta.status === "rascunho" ? "Ativar alerta" : "Retomar"}
            </button>
          )}
          {alerta.status === "ativo" && (
            <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate("pausado")} className="rounded-md border border-linha px-3 py-1 hover:bg-superficie-2">
              Pausar
            </button>
          )}
          <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate("cancelado")} className="rounded-md border border-linha px-3 py-1 hover:bg-superficie-2">
            Cancelar
          </button>
        </div>
      )}
      {mudar.isError && <p className="mt-1 text-vermelho">{(mudar.error as Error).message}</p>}
    </div>
  );
}

/** Disparo de um alerta: as três respostas da especificação (§7.6). */
function RespostaDoDisparo({ disparo, missionId }: { disparo: NonNullable<Mensagem["disparo"]>; missionId: string }) {
  const queryClient = useQueryClient();
  const [ensinando, setEnsinando] = useState(false);
  const responder = useMutation({
    mutationFn: (v: { opcao: "nao_veio" | "cobrar" | "veio"; exemplo?: string }) => responderAlerta({ data: { fireId: disparo.id, ...v } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId] });
      void queryClient.invalidateQueries({ queryKey: ["alertas", missionId] });
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    },
  });
  if (disparo.resposta) {
    return (
      <div className="mt-2 rounded-md bg-superficie-2 px-3 py-2 text-sm">
        <span className="font-medium">{disparo.respondidaPor ?? "Alguém"}</span> respondeu: {RESPOSTA_DISPARO[disparo.resposta.opcao]}
        {disparo.resposta.exemplo && <p className="text-muted">A IA aprendeu: “{disparo.resposta.exemplo}”</p>}
      </div>
    );
  }
  return (
    <div className="mt-2 text-sm">
      {!ensinando ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={responder.isPending} onClick={() => responder.mutate({ opcao: "nao_veio" })} className="rounded-md border border-linha px-3 py-1 hover:bg-superficie-2">
            Realmente não veio
          </button>
          <button type="button" disabled={responder.isPending} onClick={() => responder.mutate({ opcao: "cobrar" })} className="rounded-md border border-linha px-3 py-1 hover:bg-superficie-2">
            Vou cobrar o líder de campo
          </button>
          <button type="button" onClick={() => setEnsinando(true)} className="rounded-md border border-linha px-3 py-1 hover:bg-superficie-2">
            Veio, mas você não encontrou
          </button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            responder.mutate({ opcao: "veio", exemplo: String(new FormData(e.currentTarget).get("exemplo") ?? "") });
          }}
        >
          <label className="grid min-w-56 flex-1 gap-1">
            Como estava escrito no RDO?
            <input name="exemplo" required minLength={3} maxLength={300} placeholder="Ex.: frente liberada: 120 m de linha" className="rounded-md border border-linha bg-superficie-2 px-2 py-1" />
          </label>
          <button type="submit" disabled={responder.isPending} className="rounded-md bg-floresta px-3 py-1 font-medium text-white">
            Ensinar a IA
          </button>
        </form>
      )}
      {responder.isError && <p className="mt-1 text-vermelho">{(responder.error as Error).message}</p>}
    </div>
  );
}

export function CartaoIA({ m, missionId }: { m: Mensagem; missionId: string }) {
  const p = m.pergunta;
  return (
    <li data-msg={m.id} className="flex justify-start">
      <div className="max-w-[85%] rounded-lg border border-dashed border-lilas bg-superficie px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-floresta-texto">
          <Sparkles size={13} aria-hidden /> Assistente do Omni
        </p>
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        {p?.status === "enviada" && <Respostas pergunta={p} missionId={missionId} />}
        {m.alerta && <AcoesDoAlerta alerta={m.alerta} missionId={missionId} />}
        {m.disparo && <RespostaDoDisparo disparo={m.disparo} missionId={missionId} />}
        {p?.status === "respondida" && p.resposta && (
          <div className="mt-2 rounded-md bg-superficie-2 px-3 py-2 text-sm">
            <p>
              <span className="font-medium">{p.respondidaPor ?? "Alguém"}</span> respondeu: {p.resposta.rotulo}
              {p.resposta.nova_data
                ? ` · ${(p.opcoes.find((o) => o.id === p.resposta?.opcao)?.rotulos.nova_data ?? "Nova data").toLowerCase()}: ${dataBr(p.resposta.nova_data)}`
                : ""}
            </p>
            {p.resposta.motivo && <p className="text-muted">Motivo: {p.resposta.motivo}</p>}
            {p.resposta.detalhe && <p className="whitespace-pre-wrap text-muted">{p.resposta.detalhe}</p>}
            {p.resposta.tarefa && (
              <p className="mt-1 text-xs text-floresta-texto">
                Tarefa criada para {p.respondidaPor ?? "quem respondeu"}: “{p.resposta.tarefa.titulo}” (aba Tarefas da missão).
              </p>
            )}
            {p.desvio && <p className="mt-1 text-xs text-muted">{DESVIO[p.desvio.status](p.desvio.numero)}</p>}
            {p.descarga && <p className="mt-1 text-xs text-muted">{DESCARGA[p.descarga.status]}</p>}
          </div>
        )}
        <p className="mt-0.5 text-right text-[11px] text-muted">{horario(m.createdAt)}</p>
      </div>
    </li>
  );
}
