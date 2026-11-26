import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { separadorDoDia } from "../../lib/datas-sp.ts";
import {
  ArrowLeft,
  ListChecks,
  Link2,
  Mail,
  MessageCircle,
  PenSquare,
  Users, User } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import type { ConversaResumo } from "../../lib/conversas-fns.ts";
import type { MissaoResumo } from "../../lib/missions-fns.ts";
import {
  digitos,
  telefonesParaAgenda,
  type ContatoUnico,
} from "../../lib/caixa-unica.ts";
import { SugestoesDeVinculo } from "./Sugestoes.tsx";
import { AvisoNaoLidas, SetaParaBaixo, useRolagemDoChat } from "../comum/RolagemDoChat.tsx";
import { acaoLida, BotaoLida, useDeslizarLados, useMenuDeContexto } from "../comum/MarcarLida.tsx";
import { marcarEmailsDoContato } from "../../lib/caixa-fns.ts";
import {
  agendaPara,
  correspondentesDeEmail,
  emailsDoContato,
  type Correspondente,
} from "../../lib/unica-fns.ts";

export {
  acharContato,
  juntarContatos,
  type ContatoUnico,
} from "../../lib/caixa-unica.ts";
import { FalhaAoCarregar } from "../comum/TentarDeNovo.tsx";
import { FotoConversa, quandoCurto, useMarcarConversaLida } from "../conversas/Conversas.tsx";
import { CartaoEmail } from "./CartaoEmail.tsx";
import { VincularContato } from "./Vincular.tsx";
import { useListaProgressiva } from "../comum/ListaProgressiva.tsx";

/**
 * Caixa única (decisão de 17/11/2026): Conversas, E-mails, Missões e Tarefas numa lista,
 * com filtros. Em "Tudo", um item por contato: a conversa do WhatsApp e os e-mails do
 * mesmo contato (ligados pela agenda da empresa) ficam juntos. Quem só tem e-mail
 * aparece pelo e-mail, e pode ganhar o telefone depois (Vincular).
 */

export type FiltroCaixa =
  "tudo" | "conversas" | "emails" | "missoes" | "tarefas";
export const FILTROS: { id: FiltroCaixa; rotulo: string }[] = [
  { id: "tudo", rotulo: "Tudo" },
  { id: "conversas", rotulo: "WhatsApp" },
  { id: "emails", rotulo: "E-mail" },
  { id: "missoes", rotulo: "Missões" },
  { id: "tarefas", rotulo: "Tarefas" },
];

export function FiltrosDaCaixa({
  atual,
  onFiltro,
  visiveis,
}: {
  atual: FiltroCaixa;
  onFiltro: (f: FiltroCaixa) => void;
  /** Filtros dos módulos liberados para a pessoa (0071). */
  visiveis?: FiltroCaixa[];
}) {
  return (
    <div
      role="tablist"
      aria-label="Filtrar a caixa"
      className="mt-3 flex gap-0.5 rounded-lg border border-linha p-0.5"
    >
      {FILTROS.filter((f) => !visiveis || visiveis.includes(f.id)).map((f) => (
        <button
          key={f.id}
          type="button"
          role="tab"
          aria-selected={atual === f.id}
          onClick={() => onFiltro(f.id)}
          className={`flex-auto whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium ${atual === f.id ? "bg-floresta text-white" : "text-muted hover:bg-superficie-2 hover:text-ink"}`}
        >
          {f.rotulo}
        </button>
      ))}
    </div>
  );
}

/** Agenda da empresa para as conversas e os correspondentes da pessoa. */
export function useAgenda(
  conversas: ConversaResumo[] | undefined,
  correspondentes: Correspondente[] | undefined,
  ativo: boolean,
) {
  const telefones = telefonesParaAgenda(conversas ?? []);
  const emails = [
    ...new Set((correspondentes ?? []).map((c) => c.endereco)),
  ].sort();
  return useQuery({
    queryKey: [
      "unica",
      "agenda",
      telefones.length,
      emails.length,
      telefones.at(-1),
      emails.at(-1),
    ],
    queryFn: () =>
      agendaPara({
        data: {
          telefones: telefones.slice(0, 3000),
          emails: emails.slice(0, 3000),
        },
      }),
    enabled: ativo && Boolean(conversas || correspondentes),
    staleTime: 60_000,
  });
}

export function useCorrespondentes(ativo: boolean) {
  return useQuery({
    queryKey: ["unica", "correspondentes"],
    queryFn: () => correspondentesDeEmail(),
    enabled: ativo,
    refetchInterval: 5 * 60_000,
  });
}

function Avatar({ c }: { c: ContatoUnico }) {
  if (c.conversa) return <FotoConversa c={c.conversa} tamanho="size-11" />;
  return (
    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-azul text-white">
      <span className="text-sm font-semibold">
        {/^\p{L}/u.test(c.nome) ? c.nome.slice(0, 2).toUpperCase() : <User size={18} aria-hidden />}
      </span>
    </span>
  );
}

/**
 * Missão com mensagens não lidas na lista "Tudo". Fica na posição da última mensagem de
 * PESSOA no Interno/Gerencial: aviso da IA ou do sistema conta como não lido, mas não sobe.
 */
export type MissaoNaCaixa = {
  missao: MissaoResumo;
  dePessoas: number;
  daIa: number;
  ultimaEm: string | null;
  previa: string | null;
};

/** Lista "Tudo": tarefas, e por ordem da última mensagem de pessoa ou e-mail: contatos (WhatsApp + e-mail) e missões com novidade. */
export function ListaUnica({
  contatos,
  carregando,
  falha,
  selecionado,
  onSelecionar,
  busca,
  missoesComNovidade,
  onAbrirMissao,
  tarefas,
  onAbrirTarefas,
}: {
  contatos: ContatoUnico[];
  carregando: boolean;
  falha: Parameters<typeof FalhaAoCarregar>[0]["consulta"] | null;
  selecionado: string | null;
  onSelecionar: (chave: string) => void;
  busca: string;
  missoesComNovidade: MissaoNaCaixa[];
  onAbrirMissao: (id: string) => void;
  tarefas: { minhas: number; atrasadas: number } | null;
  onAbrirTarefas: () => void;
}) {
  const termo = busca.trim().toLowerCase();
  const soDigitos = digitos(busca);
  const filtrados = termo
    ? contatos.filter(
        (c) =>
          [c.nome, c.empresa ?? "", c.previa ?? "", ...c.enderecos].some((x) =>
            x.toLowerCase().includes(termo),
          ) ||
          (soDigitos.length >= 4 &&
            c.telefones.some((t) => t.includes(soDigitos))),
      )
    : contatos.filter((c) => !c.conversa?.concluida || c.emailsNaoLidos > 0);
  const missoes = termo
    ? missoesComNovidade.filter((m) =>
        [m.missao.code, m.missao.clientName, m.previa ?? ""].some((x) =>
          x.toLowerCase().includes(termo),
        ),
      )
    : missoesComNovidade;
  const linhas: Array<
    | { k: "contato"; em: string; c: ContatoUnico }
    | { k: "missao"; em: string; m: MissaoNaCaixa }
  > = [
    ...filtrados.map((c) => ({
      k: "contato" as const,
      em: c.ultimaEm ?? "",
      c,
    })),
    ...missoes.map((m) => ({ k: "missao" as const, em: m.ultimaEm ?? "", m })),
  ].sort((a, b) => b.em.localeCompare(a.em));
  const progressiva = useListaProgressiva(linhas.length, termo);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!termo && <SugestoesDeVinculo contatos={contatos} />}
      {!termo && tarefas && (tarefas.minhas > 0 || tarefas.atrasadas > 0) && (
        <ul className="border-b border-linha">
          {tarefas && (tarefas.minhas > 0 || tarefas.atrasadas > 0) && (
            <li>
              <button
                type="button"
                onClick={onAbrirTarefas}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-superficie-2"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  <ListChecks size={18} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    Minhas tarefas
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {tarefas.minhas} aberta{tarefas.minhas === 1 ? "" : "s"}
                    {tarefas.atrasadas
                      ? ` · ${tarefas.atrasadas} atrasada${tarefas.atrasadas === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
      {falha && !contatos.length ? (
        <FalhaAoCarregar
          mensagem="Não foi possível carregar a caixa."
          consulta={falha}
          className="px-6 py-10"
        />
      ) : carregando && !contatos.length ? (
        <p className="px-6 py-10 text-center text-muted">Carregando…</p>
      ) : !linhas.length ? (
        <p className="px-6 py-10 text-center text-muted">
          {termo
            ? "Nada encontrado."
            : "Nenhuma conversa ou e-mail nos últimos 90 dias."}
        </p>
      ) : (
        <ul>
          {linhas.slice(0, progressiva.limite).map((l) => {
            if (l.k === "missao") {
              const { missao, dePessoas, daIa, previa } = l.m;
              return (
                <li key={`m:${missao.id}`} className="border-b border-linha">
                  <button
                    type="button"
                    onClick={() => onAbrirMissao(missao.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-superficie-2"
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-floresta/15 text-floresta-texto">
                      <Users size={18} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={`truncate ${dePessoas ? "font-semibold" : "font-medium"}`}
                        >
                          {missao.code} · {missao.clientName}
                        </span>
                        <span className="shrink-0 text-xs text-muted">
                          {quandoCurto(l.m.ultimaEm)}
                        </span>
                      </span>
                      {previa && (
                        <span className="block truncate text-sm text-muted">
                          {previa}
                        </span>
                      )}
                      <span className="block truncate text-xs text-muted">
                        Missão · Interno e Gerencial
                        {daIa
                          ? ` · ${daIa} aviso${daIa === 1 ? "" : "s"} da IA`
                          : ""}
                      </span>
                    </span>
                    {dePessoas > 0 ? (
                      <span
                        className="min-w-5 rounded-full bg-floresta px-1.5 text-center text-xs font-semibold leading-5 text-white"
                        aria-label={`${dePessoas} mensagens novas`}
                      >
                        {dePessoas > 99 ? "99+" : dePessoas}
                      </span>
                    ) : (
                      <span
                        className="rounded-full border border-linha px-1.5 text-[10px] font-semibold leading-4 text-muted"
                        aria-label={`${daIa} avisos da IA`}
                      >
                        IA
                      </span>
                    )}
                  </button>
                </li>
              );
            }
            const c = l.c;
            return <ItemContato key={c.chave} c={c} selecionado={selecionado === c.chave} onSelecionar={onSelecionar} />;
          })}
          {progressiva.faltam > 0 && <li ref={progressiva.sentinela} className="h-8" aria-hidden />}
        </ul>
      )}
    </div>
  );
}

/**
 * Um contato na lista "Tudo". Não lido: WhatsApp com mensagens depois da leitura (ou marcado)
 * e e-mails não lidos. Lida/não lida pelo botão que aparece ao passar o mouse, pelo botão
 * direito ou deslizando para a direita: marca a conversa e os e-mails do contato.
 */
const ItemContato = memo(function ItemContato({ c, selecionado, onSelecionar }: { c: ContatoUnico; selecionado: boolean; onSelecionar: (chave: string) => void }) {
  const qc = useQueryClient();
  const marcarConversa = useMarcarConversaLida();
  const conversaNaoLida = Boolean(c.conversa && c.conversa.podeResponder && (c.conversa.naoLidas > 0 || c.conversa.marcadaNaoLida));
  const naoLidas = (c.conversa?.naoLidas ?? 0) + c.emailsNaoLidos;
  const [lidaLocal, setLidaLocal] = useState<boolean | null>(null);
  const lida = lidaLocal ?? (!conversaNaoLida && c.emailsNaoLidos === 0);
  useEffect(() => setLidaLocal(null), [conversaNaoLida, c.emailsNaoLidos]);
  const emails = useMutation({
    mutationFn: (v: boolean) => marcarEmailsDoContato({ data: { enderecos: c.enderecos.slice(0, 20), lido: v } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["unica"] });
      void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] === "caixa" && x.queryKey[1] !== "email" });
    },
    onError: () => setLidaLocal(null),
  });
  const alternar = () => {
    const v = !lida;
    setLidaLocal(v);
    const temConversa = Boolean(c.conversa?.podeResponder);
    if (v) {
      if (temConversa && conversaNaoLida) marcarConversa.mutate({ chatId: c.conversa!.id, lida: true });
      if (c.emailsNaoLidos > 0 && c.enderecos.length) emails.mutate(true);
    } else if (temConversa) marcarConversa.mutate({ chatId: c.conversa!.id, lida: false });
    else if (c.enderecos.length) emails.mutate(false);
  };
  const podeMarcar = Boolean(c.conversa?.podeResponder || c.enderecos.length);
  const { dx, moveu, fundo, handlers } = useDeslizarLados({ direita: podeMarcar ? acaoLida(lida, alternar) : undefined });
  const menu = useMenuDeContexto(podeMarcar ? [acaoLida(lida, alternar)] : []);
  return (
    <li className="group relative border-b border-linha" onContextMenu={podeMarcar ? menu.abrir : undefined}>
      {fundo}
      <button
        type="button"
        {...handlers}
        onClick={() => {
          if (moveu.current) return;
          onSelecionar(c.chave);
        }}
        aria-current={selecionado ? "true" : undefined}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        className={`relative flex w-full touch-pan-y items-center gap-3 bg-superficie py-3 pl-4 pr-4 text-left hover:bg-superficie-2 md:pr-11 ${selecionado ? "bg-superficie-2" : ""}`}
      >
        <Avatar c={c} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate ${lida ? "font-medium" : "font-semibold"}`}>{c.nome}</span>
            <span className={`shrink-0 text-xs ${lida ? "text-muted" : "font-semibold text-floresta-texto"}`}>{quandoCurto(c.ultimaEm)}</span>
          </span>
          {c.previa && (
            <span className={`flex items-center gap-1 truncate text-sm ${lida ? "text-muted" : "text-ink"}`}>
              {c.canal === "email" ? <Mail size={13} aria-label="E-mail" className="shrink-0" /> : <MessageCircle size={13} aria-label="WhatsApp" className="shrink-0" />}
              <span className="truncate">{c.previa}</span>
            </span>
          )}
          <span className="block truncate text-xs text-muted">
            {[
              c.conversa ? `WhatsApp${c.conversa.grupo ? " · Grupo" : ""}` : null,
              c.empresa,
              c.enderecos.length ? `${c.enderecos[0]}${c.enderecos.length > 1 ? ` +${c.enderecos.length - 1}` : ""}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {!lida &&
          (naoLidas ? (
            <span className="min-w-5 shrink-0 rounded-full bg-floresta px-1.5 text-center text-xs font-semibold leading-5 text-white" aria-label={`${naoLidas} não lidas`}>
              {naoLidas > 99 ? "99+" : naoLidas}
            </span>
          ) : (
            <span className="size-3 shrink-0 rounded-full bg-floresta-texto" aria-label="Marcada como não lida" />
          ))}
      </button>
      {dx === 0 && podeMarcar && (
        <div className="absolute bottom-2 right-2">
          <BotaoLida lida={lida} alternar={alternar} />
        </div>
      )}
      {emails.isError && (
        <p role="alert" className="px-4 pb-1 text-xs text-vermelho">
          {emails.error instanceof Error ? emails.error.message : "Não foi possível marcar."}
        </p>
      )}
      {menu.menu}
    </li>
  );
});

const TZ = { timeZone: "America/Sao_Paulo" } as const;

/** Contato só com e-mail (sem conversa do WhatsApp): linha do tempo dos e-mails e vincular o telefone. */
export function PainelContatoEmail({
  contato,
  onVoltar,
  onAbrirEmail,
  onEscreverEmail,
}: {
  contato: ContatoUnico;
  onVoltar: () => void;
  onAbrirEmail: (graphId: string) => void;
  onEscreverEmail: (para: string) => void;
}) {
  const [vincular, setVincular] = useState(false);
  const q = useQuery({
    queryKey: ["unica", "emails", contato.enderecos.join(",")],
    queryFn: () =>
      emailsDoContato({ data: { enderecos: contato.enderecos.slice(0, 20) } }),
    enabled: contato.enderecos.length > 0,
  });
  const emails = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => Date.parse(a.em) - Date.parse(b.em)),
    [q.data],
  );
  // Como no chat: abre no fim, ou no primeiro e-mail não lido (com o contador).
  const rolagem = useRolagemDoChat(
    `email:${contato.chave}`,
    q.data ? emails.map((e) => ({ id: e.id, em: e.em, deMim: e.pasta === "sentitems", naoLida: e.pasta === "inbox" && !e.lido })) : undefined,
  );
  let dia = "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-linha bg-superficie px-5 py-3">
        <button
          type="button"
          onClick={onVoltar}
          aria-label="Voltar para a lista"
          className="-ml-2 flex size-9 items-center justify-center rounded-md hover:bg-superficie-2 md:hidden"
        >
          <ArrowLeft size={20} />
        </button>
        <Avatar c={contato} />
        <div className="min-w-0">
          <p className="truncate font-semibold">{contato.nome}</p>
          <p className="truncate text-sm text-muted">
            {contato.enderecos.join(", ")}
            {contato.empresa ? ` · ${contato.empresa}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onEscreverEmail(contato.enderecos[0]!)}
            className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm font-medium hover:bg-superficie-2"
          >
            <PenSquare size={18} aria-hidden />{" "}
            <span className="hidden sm:inline">Escrever</span>
          </button>
          <button
            type="button"
            onClick={() => setVincular(true)}
            title="Vincular o telefone: o WhatsApp deste contato passa a aparecer junto"
            className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm font-medium hover:bg-superficie-2"
          >
            <Link2 size={18} aria-hidden />{" "}
            <span className="hidden sm:inline">Vincular telefone</span>
          </button>
        </div>
      </header>
      {contato.telefones.length > 0 && (
        <p className="border-b border-linha bg-superficie-2 px-5 py-2 text-sm text-muted">
          Telefone vinculado: {contato.telefones.join(", ")}. A conversa aparece
          aqui quando houver mensagens no seu WhatsApp com esse número.
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={rolagem.caixa} onScroll={rolagem.aoRolar} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-fundo p-5">
        {q.isPending && <p className="text-center text-muted">Carregando…</p>}
        {q.isError && (
          <FalhaAoCarregar
            mensagem="Não foi possível carregar os e-mails."
            consulta={q}
          />
        )}
        {q.data && !emails.length && (
          <p className="text-center text-muted">
            Nenhum e-mail guardado com este contato.
          </p>
        )}
        {emails.map((e) => {
          const em = new Date(e.em);
          const d = separadorDoDia(em);
          const novoDia = d !== dia;
          dia = d;
          return (
            <div key={e.id} data-msg={e.id}>
              {novoDia && (
                <p className="my-3 text-center">
                  <span className="rounded-full bg-superficie px-2.5 py-0.5 text-xs text-muted shadow-sm">
                    {d}
                  </span>
                </p>
              )}
              {rolagem.divisor?.id === e.id && <AvisoNaoLidas n={rolagem.divisor.n} />}
              <CartaoEmail e={e} onAbrir={onAbrirEmail} />
            </div>
          );
        })}
      </div>
      <SetaParaBaixo visivel={!rolagem.noFim || rolagem.naoLidasAbaixo > 0} naoLidas={rolagem.naoLidasAbaixo} onClick={rolagem.descer} />
      </div>
      {vincular && (
        <VincularContato
          nome={contato.nome}
          email={contato.enderecos[0] ?? null}
          contatoId={contato.contatoId}
          fechar={() => setVincular(false)}
        />
      )}
    </div>
  );
}
