import { formatarTelefone } from "@omni/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Share2 } from "lucide-react";
import { useState } from "react";

import { compartilharGravacao, excluirGravacao, type LigacaoNaLista } from "../../lib/chamadas-fns.ts";
import { ResumoChamada } from "./ResumoChamada.tsx";

/**
 * Uma ligação na lista: quem, quando, duração, gravação (ouvir, compartilhar,
 * excluir) e resumo e transcrição pela IA. Usada na aba Ligações e na aba
 * Ligações de cada conversa.
 */

const botao = "inline-flex items-center gap-1.5 rounded-md border border-linha px-3 py-2 text-sm hover:bg-superficie-2 disabled:opacity-40";
const campo = "rounded-md border border-linha bg-superficie px-3 py-2 text-sm";
const duracao = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function ItemDeLigacao({
  c,
  pessoas,
  naConversa = false,
  podeLigar,
  aoLigar,
  aoAbrirConversa,
}: {
  c: LigacaoNaLista;
  /** Com quem a gravação pode ser compartilhada (só o dono vê). */
  pessoas: { id: string; nome: string }[];
  /** Dentro da conversa: o contato já é conhecido, mostra o tipo da ligação. */
  naConversa?: boolean;
  podeLigar: boolean;
  aoLigar: () => void;
  aoAbrirConversa?: (chatId: string) => void;
}) {
  const qc = useQueryClient();
  const [erro, setErro] = useState("");
  const [compartilhando, setCompartilhando] = useState(false);
  const [busca, setBusca] = useState("");
  const [escolhas, setEscolhas] = useState<Record<string, boolean>>({});
  const atualizar = () => void qc.invalidateQueries({ queryKey: ["chamadas"] });
  const compartilhar = useMutation({
    mutationFn: compartilharGravacao,
    onMutate: () => setErro(""),
    onError: (e: Error) => setErro(e.message),
    onSettled: async (_d, _e, v) => {
      await qc.invalidateQueries({ queryKey: ["chamadas"] });
      setEscolhas((atual) => {
        const prox = { ...atual };
        delete prox[v.data.personId];
        return prox;
      });
    },
  });
  const remover = useMutation({ mutationFn: excluirGravacao, onMutate: () => setErro(""), onError: (e: Error) => setErro(e.message), onSuccess: atualizar });

  const perdida = c.direcao === "entrada" && !c.inicio && c.estado === "encerrada";
  const Icone = perdida ? PhoneMissed : c.direcao === "entrada" ? PhoneIncoming : PhoneOutgoing;
  const tipo = perdida ? "Perdida" : c.direcao === "entrada" ? "Recebida" : "Feita";
  const nome = naConversa ? `Ligação ${tipo.toLowerCase()}` : (c.contato?.nome ?? formatarTelefone(c.telefone) ?? c.telefone);
  const seg = c.inicio && c.fim ? Math.round((new Date(c.fim).getTime() - new Date(c.inicio).getTime()) / 1000) : null;
  const quando = new Date(c.criadaEm);
  const deOutroAno = quando.getFullYear() !== new Date().getFullYear();
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Icone size={18} className={perdida ? "text-vermelho" : "text-muted"} aria-label={tipo} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate font-medium ${perdida ? "text-vermelho" : ""}`}>{nome}</span>
          <span className="block text-xs text-muted">
            {quando.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", ...(deOutroAno ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}
            {seg !== null ? ` · ${duracao(seg)}` : perdida ? " · não atendida" : ""}
            {!c.minha && " · compartilhada com você"}
            {c.erroGravacao && " · falha na gravação"}
          </span>
        </span>
        {!naConversa && c.minha && c.contato && aoAbrirConversa && (
          <button type="button" className={botao} aria-label="Abrir conversa" onClick={() => aoAbrirConversa(c.contato!.chatId)}>
            <MessageCircle size={16} />
          </button>
        )}
        {c.minha && (
          <button type="button" className={botao} aria-label={`Ligar de volta para ${c.contato?.nome ?? formatarTelefone(c.telefone) ?? c.telefone}`} disabled={!podeLigar} onClick={aoLigar}>
            <Phone size={16} />
          </button>
        )}
      </div>
      {c.audio && (
        <div className="flex flex-wrap items-center gap-2 pl-8">
          <audio controls preload="none" src={`/api/chamadas/gravacoes/${c.id}`} className="h-9 max-w-full" />
          {c.minha && (
            <>
              <button type="button" className={botao} aria-expanded={compartilhando} onClick={() => setCompartilhando(!compartilhando)}>
                <Share2 size={14} /> Compartilhar
              </button>
              <button
                type="button"
                className={botao}
                disabled={remover.isPending}
                onClick={() => confirm("Excluir esta gravação, a transcrição e o resumo, e revogar os compartilhamentos?") && remover.mutate({ data: { callId: c.id } })}
              >
                Excluir gravação
              </button>
            </>
          )}
        </div>
      )}
      {(c.resumo || c.resumoSituacao || (c.minha && c.audio)) && (
        <div className="pl-8">
          <ResumoChamada callId={c.id} resumo={c.resumo} situacao={c.resumoSituacao} temTranscricao={c.temTranscricao} compacto podePedir={c.minha && c.audio} podeRegistrar={c.minha} />
        </div>
      )}
      {erro && <p className="pl-8 text-sm text-vermelho">{erro}</p>}
      {compartilhando && c.minha && c.audio && (
        <div className="space-y-2 border-t border-linha pt-3 pl-8">
          <p className="text-sm text-muted">Somente as pessoas marcadas podem ouvir. Desmarque para revogar.</p>
          <input className={campo} aria-label="Buscar pessoa para compartilhar" placeholder="Buscar pessoa" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <div className="grid max-h-48 gap-2 overflow-y-auto">
            {pessoas
              .filter((x) => x.nome.toLowerCase().includes(busca.toLowerCase()))
              .map((x) => (
                <label className="flex items-center gap-2 text-sm" key={x.id}>
                  <input
                    type="checkbox"
                    checked={escolhas[x.id] ?? c.compartilhadaCom.includes(x.id)}
                    disabled={compartilhar.isPending}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setEscolhas((atual) => ({ ...atual, [x.id]: v }));
                      compartilhar.mutate({ data: { callId: c.id, personId: x.id, compartilhar: v } });
                    }}
                  />
                  {x.nome}
                </label>
              ))}
          </div>
        </div>
      )}
    </li>
  );
}
