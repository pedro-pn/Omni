import { BellRing, ChartColumn, Inbox, KeyRound, ListChecks, LogOut, type LucideIcon, Mail, MessageCircle, Moon, Phone, Search, Settings, ShieldCheck, Smartphone, Sun, Target, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { getNaoLidas, novidadesDasMissoes } from "../../lib/canais-fns.ts";
import { listMissoes } from "../../lib/missions-fns.ts";
import type { Me } from "../../lib/session-fns.ts";
import { MissionContext, MissionDetail, MissionList } from "../missions/Missions.tsx";
import { DetalheTarefa } from "../tarefas/DetalheTarefa.tsx";
import { TarefasContexto, TarefasNav, TarefasPainel, useContextoTarefas } from "../tarefas/Tarefas.tsx";
import { revisaoSemanal } from "../../lib/revisao-fns.ts";
import { RevisaoNav, RevisaoPainel, type FiltroRevisao } from "../revisao/Revisao.tsx";
import { SinoAvisos } from "./Avisos.tsx";
import type { VistaTarefas } from "../../lib/tarefas-fns.ts";
import { AvisoConversas, ListaConversas, PainelConversa, useConversas, useSincronizarHistoricoDoWhatsApp } from "../conversas/Conversas.tsx";
import { NoPrismaInfo } from "../prisma/NoPrisma.tsx";
import { apagarHistoricoDoAparelho, definirPessoaDoAparelho } from "../../lib/whatsapp-aparelho.ts";
import { FalhaAoCarregar } from "../comum/TentarDeNovo.tsx";
import { EmailsCentro, EmailsLista, useAvisosDaCaixa, type CentroEmail } from "../emails/CaixaDeEmail.tsx";
import { desinscreverEsteAparelho, iniciarAppInstalavel, inscreverEsteAparelho, NotificacoesApp } from "./NotificacoesApp.tsx";
import { PrismaConexao } from "./PrismaConexao.tsx";
import { configPush } from "../../lib/push-fns.ts";
import { useChamadasPerdidas } from "../chamadas/Chamadas.tsx";
import { useCamadaChamadas } from "../chamadas/CamadaChamadas.tsx";
import { emailDoAviso } from "../../lib/caixa-fns.ts";
import { ContatoEPrisma } from "../unica/Sugestoes.tsx";
import { acharContato, FiltrosDaCaixa, juntarContatos, ListaUnica, PainelContatoEmail, useAgenda, useCorrespondentes, type FiltroCaixa } from "../unica/CaixaUnica.tsx";
import type { Modulo } from "@omni/core";

/**
 * Casca da tela única (protótipo: trilho 64px | lista 340px | conversa | painel 370px).
 * No celular (≤760px) mostra uma coluna por vez e o trilho vira barra inferior.
 * Os módulos entram fase a fase (PLANEJAMENTO.md §8); por enquanto, estados vazios.
 */

type View = "tudo" | "conversas" | "emails" | "missoes" | "tarefas" | "revisao" | "chamadas";
/** Caixa única (17/11/2026): estas vistas são filtros de uma aba só. */
const NA_CAIXA: View[] = ["tudo", "conversas", "emails", "missoes", "tarefas"];
/** Módulo de cada vista (0071): sem o módulo liberado, a vista some. "tudo" sempre aparece. */
const MODULO_DA_VISTA: Partial<Record<View, Modulo>> = {
  conversas: "whatsapp",
  emails: "emails",
  missoes: "missoes",
  tarefas: "tarefas",
  revisao: "revisao",
  chamadas: "chamadas",
};

const VIEWS: Array<{ id: View; label: string; icon: LucideIcon; empty: string }> = [
  { id: "tudo", label: "Caixa", icon: Inbox, empty: "Conversas, e-mails, missões e tarefas." },
  {
    id: "conversas",
    label: "Conversas",
    icon: MessageCircle,
    empty: "Nenhuma conversa ainda. Elas aparecem aqui quando WhatsApp e Outlook forem conectados.",
  },
  {
    id: "emails",
    label: "E-mails",
    icon: Mail,
    empty: "A sua caixa de e-mail.",
  },
  {
    id: "missoes",
    label: "Missões",
    icon: Users,
    empty: "As missões chegam do filtroAPP, com os canais Interno e Gerencial.",
  },
  {
    id: "tarefas",
    label: "Tarefas",
    icon: ListChecks,
    empty: "Suas tarefas e as dos seus projetos.",
  },
  {
    id: "revisao",
    label: "Revisão semanal",
    icon: ChartColumn,
    empty: "A revisão semanal é para gerentes e diretoria.",
  },
  { id: "chamadas", label: "Chamadas", icon: Phone, empty: "Suas chamadas e gravações." },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const explicit = document.documentElement.dataset.theme;
    setDark(explicit ? explicit === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("omni-tema", next);
    } catch {
      // sem armazenamento: vale só nesta aba
    }
    setDark(!dark);
  };
  return { dark, toggle };
}

function RailButton({
  label,
  icon: Icon,
  active,
  onClick,
  badge = 0,
  ponto = false,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
  badge?: number;
  /** Ponto verde (ex.: linha pronta para receber ligações). */
  ponto?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      className={`flex size-11 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white ${
        active ? "bg-white/15 text-white" : ""
      }`}
    >
      <span className="relative">
        <Icon size={22} strokeWidth={1.9} />
        {ponto && badge === 0 && <span className="absolute -bottom-0.5 -right-1 size-2.5 rounded-full border-2 border-floresta bg-[#4ade80]" aria-hidden />}
        {badge > 0 && (
          <span className="absolute -right-2 -top-1.5 min-w-4 rounded-full bg-vermelho px-1 text-center text-[10px] font-semibold leading-4 text-white" aria-label={`${badge} não vistas`}>
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </span>
    </button>
  );
}

export function AppShell({ me }: { me: Me }) {
  // Módulos liberados para a pessoa (Administração → Módulos, 0071).
  const liberado = (m: Modulo) => me.modulos.includes(m);
  const vistaLiberada = (v: View) => {
    const m = MODULO_DA_VISTA[v];
    return !m || liberado(m);
  };
  definirPessoaDoAparelho(me.id);
  useSincronizarHistoricoDoWhatsApp(me.id);
  // Resposta enviada por uma janela avulsa de e-mail: atualiza a caixa aqui.
  useAvisosDaCaixa();
  const [view, setView] = useState<View>("tudo");
  const [contatoUnico, setContatoUnico] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificacoesAbertas, setNotificacoesAbertas] = useState(false);
  const [busca, setBusca] = useState("");
  const [missaoId, setMissaoId] = useState<string | null>(null);
  const [conversaId, setConversaId] = useState<string | null>(null);
  const [centroEmail, setCentroEmail] = useState<CentroEmail | null>(null);
  const [abaMissao, setAbaMissao] = useState("resumo");
  const [vistaTarefas, setVistaTarefas] = useState<VistaTarefas | null>(null);
  const [tarefaDoAviso, setTarefaDoAviso] = useState<string | null>(null);
  const [filtroRevisao, setFiltroRevisao] = useState<FiltroRevisao>("todas");
  // Links: tarefa (/?task=ID, o formato do Foco, ou /?tarefa=ID), missão (/?missao=ID&aba=interno),
  // conversa (/?conversa=ID) e aba (/?ver=tarefas) — também o que a notificação do celular abre.
  useEffect(() => {
    const abrirPelaUrl = (endereco: string) => {
      const busca = new URL(endereco, window.location.origin).searchParams;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const tarefa = busca.get("task") ?? busca.get("tarefa");
      const missao = busca.get("missao");
      const conversa = busca.get("conversa");
      const email = busca.get("email");
      if (tarefa && uuid.test(tarefa)) setTarefaDoAviso(tarefa.toLowerCase());
      else if (missao && uuid.test(missao)) abrirMissao(missao.toLowerCase(), busca.get("aba") ?? "resumo");
      else if (conversa && uuid.test(conversa)) {
        setView("conversas");
        setConversaId(conversa.toLowerCase());
      } else if (email && uuid.test(email)) {
        // Aviso de e-mail novo: abre o e-mail na aba E-mails.
        setView("emails");
        void emailDoAviso({ data: { itemId: email.toLowerCase() } }).then((r) => r && setCentroEmail({ tipo: "ler", id: r.graphId })).catch(() => undefined);
      } else if (busca.has("chamadas")) setView("chamadas");
      else if (VIEWS.some((v) => v.id === busca.get("ver")) && vistaLiberada(busca.get("ver") as View)) setView(busca.get("ver") as View);
      else return;
      window.history.replaceState(null, "", "/");
    };
    abrirPelaUrl(window.location.href);
    // Com o app já aberto, o service worker manda o endereço da notificação tocada.
    const aoMensagemDoSw = (e: MessageEvent) => {
      if (e.data?.tipo === "abrir" && typeof e.data.url === "string") abrirPelaUrl(e.data.url);
    };
    navigator.serviceWorker?.addEventListener("message", aoMensagemDoSw);
    return () => navigator.serviceWorker?.removeEventListener("message", aoMensagemDoSw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tela única: só as colunas rolam; a página nunca (algo que passe da altura da tela
  // deixava rolar a página inteira e aparecia um espaço vazio embaixo). Sai ao desmontar,
  // para as outras páginas (Administração, termo) rolarem normalmente.
  useEffect(() => {
    document.documentElement.classList.add("tela-unica");
    return () => document.documentElement.classList.remove("tela-unica");
  }, []);
  const { dark, toggle } = useTheme();
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;
  const semAcesso = me.profiles.length === 0;

  // Chamadas e eventos ao vivo ficam na raiz do app (CamadaChamadas): tocam em qualquer tela.
  const camada = useCamadaChamadas();
  const linhaPronta = camada.linhaPronta;
  useEffect(() => {
    camada.registrar({
      abrir: () => setView("chamadas"),
      fechar: () => setView("tudo"),
      abrirConversa: (chatId) => {
        setView("conversas");
        setConversaId(chatId);
      },
    });
    return () => camada.registrar(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => camada.definirVisivel(view === "chamadas"), [camada, view]);
  const perdidas = useChamadasPerdidas(me.id);
  // App instalável: service worker e convite de instalação; se o navegador trocar a inscrição, inscreve de novo.
  useEffect(
    () =>
      iniciarAppInstalavel(() => {
        if (Notification.permission !== "granted") return;
        void configPush().then((c) => (c.chavePublica ? inscreverEsteAparelho(c.chavePublica) : undefined)).catch(() => {});
      }),
    [],
  );
  const naoLidas = useQuery({ queryKey: ["nao-lidas"], queryFn: () => getNaoLidas(), enabled: !semAcesso });
  const missoes = useQuery({
    queryKey: ["missoes"],
    queryFn: () => listMissoes(),
    enabled: view === "missoes" && !semAcesso && liberado("missoes"),
    refetchInterval: 60_000,
  });
  const missao = view === "missoes" ? (missoes.data?.find((m) => m.id === missaoId) ?? null) : null;
  const naTudo = view === "tudo" && !semAcesso;
  const conversas = useConversas((view === "conversas" || naTudo) && !semAcesso && liberado("whatsapp"));
  const correspondentes = useCorrespondentes(naTudo || (view === "conversas" && !semAcesso));
  const agenda = useAgenda(conversas.data, correspondentes.data, (naTudo || view === "conversas") && !semAcesso);
  const contatosUnicos = juntarContatos(conversas.data ?? [], correspondentes.data ?? [], agenda.data ?? []);
  const unico = naTudo ? acharContato(contatosUnicos, contatoUnico) : null;
  const conversa =
    view === "conversas" ? (conversas.data?.find((c) => c.id === conversaId) ?? null) : naTudo ? (unico?.conversa ?? null) : null;
  // A conversa aberta, com os e-mails do mesmo contato (agenda da empresa) na linha do tempo.
  const contatoDaConversa = conversa ? contatosUnicos.find((c) => c.conversa?.id === conversa.id) : undefined;
  const missoesTudo = useQuery({ queryKey: ["missoes"], queryFn: () => listMissoes(), enabled: naTudo && liberado("missoes"), staleTime: 60_000 });
  // Missões com novidade na lista "Tudo", pela última mensagem de pessoa (a IA não faz subir).
  const novidades = useQuery({ queryKey: ["nao-lidas", "caixa"], queryFn: () => novidadesDasMissoes(), enabled: naTudo, refetchInterval: 60_000 });
  const missoesComNovidade = naTudo
    ? (novidades.data ?? []).flatMap((n) => {
        const missao = missoesTudo.data?.find((m) => m.id === n.missionId);
        return missao ? [{ missao, dePessoas: n.dePessoas, daIa: n.daIa, ultimaEm: n.ultimaDePessoaEm, previa: n.previa }] : [];
      })
    : [];
  const tarefas = useContextoTarefas((view === "tarefas" || naTudo || tarefaDoAviso !== null) && !semAcesso && liberado("tarefas"));
  const veGestao = me.profiles.includes("gerente") || me.profiles.includes("diretoria");
  const revisao = useQuery({ queryKey: ["revisao"], queryFn: () => revisaoSemanal(), enabled: view === "revisao" && veGestao, refetchInterval: 5 * 60_000 });
  const revisaoDados = view === "revisao" && veGestao ? revisao.data : undefined;
  const abrirMissao = (id: string, aba = "resumo") => {
    setView("missoes");
    setMissaoId(id);
    setAbaMissao(aba);
    setBusca("");
  };
  const tarefasCtx = view === "tarefas" && !semAcesso ? tarefas.data : undefined;
  // No celular, a lista some quando algo está aberto no centro.
  const centroAberto =
    Boolean(missao) ||
    Boolean(conversa) ||
    (Boolean(tarefasCtx) && vistaTarefas !== null) ||
    Boolean(revisaoDados) ||
    ((view === "emails" || view === "tudo") && centroEmail !== null) ||
    Boolean(unico);
  const escreverEmail = (para: string) => setCentroEmail({ tipo: "escrever", rascunho: { para, cc: "", cco: "", assunto: "", texto: "" } });
  const trocarView = (v: View) => {
    setView(v);
    setMissaoId(null);
    setConversaId(null);
    setContatoUnico(null);
    setCentroEmail(null);
    setVistaTarefas(null);
    setBusca("");
  };

  // relative + overflow-hidden: nada posicionado lá dentro (ex.: rótulo sr-only no fim de um
  // painel comprido) pode aumentar a página e criar uma rolagem da página inteira.
  return (
    <div className="relative grid h-dvh overflow-hidden grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto] md:grid-cols-[64px_340px_minmax(0,1fr)] md:grid-rows-1 xl:grid-cols-[64px_340px_minmax(0,1fr)_370px]">
      {/* Trilho */}
      <nav
        aria-label="Navegação principal"
        className="order-last flex items-center justify-around bg-floresta px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:order-none md:flex-col md:justify-start md:gap-1 md:py-3"
      >
        <img src="/marca/filtrovali-simbolo-white.png" alt="Filtrovali" className="mb-3 hidden size-9 md:block" />
        {me.ambiente === "staging" && (
          <span title="Ambiente de testes: nada real sai para filtroAPP, Prisma, e-mail e WhatsApp" className="rounded bg-amber-400 px-1 py-0.5 text-[9px] font-bold tracking-wide text-black md:mb-2">
            STAGING
          </span>
        )}
        {VIEWS.filter((v) => (!NA_CAIXA.includes(v.id) || v.id === "tudo") && vistaLiberada(v.id)).map((v) => (
          <RailButton
            key={v.id}
            label={
              v.id === "chamadas"
                ? `${v.label}${perdidas ? ` (${perdidas} perdida${perdidas === 1 ? "" : "s"})` : ""}${linhaPronta ? " · pronto para receber ligações" : ""}`
                : v.label
            }
            icon={v.icon}
            active={v.id === view || (v.id === "tudo" && NA_CAIXA.includes(view))}
            badge={v.id === "chamadas" && view !== "chamadas" ? perdidas : 0}
            ponto={v.id === "chamadas" && linhaPronta}
            onClick={() => trocarView(v.id === "tudo" && NA_CAIXA.includes(view) && view !== "tudo" ? view : v.id)}
          />
        ))}
        <div className="hidden flex-1 md:block" />
        {!semAcesso && <SinoAvisos onAbrirTarefa={setTarefaDoAviso} onAbrirMissao={(id) => abrirMissao(id, "interno")} onAbrirChamadas={() => trocarView("chamadas")} />}
        <div className="hidden md:contents">
          {(me.profiles.includes("admin") || me.profiles.includes("diretoria")) && (
            <Link
              to="/admin"
              search={{ aba: "pessoas" }}
              aria-label="Administração"
              title="Administração"
              className="flex size-11 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
            >
              <Settings size={22} strokeWidth={1.9} />
            </Link>
          )}
          <RailButton label={dark ? "Usar tema claro" : "Usar tema escuro"} icon={dark ? Sun : Moon} onClick={toggle} />
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setProfileOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            title={me.displayName}
            className="mt-1 flex size-10 items-center justify-center rounded-full bg-white text-sm font-semibold text-floresta"
          >
            {initials(me.displayName)}
          </button>
          {profileOpen && (
            <div
              role="menu"
              className="absolute bottom-12 right-0 z-10 w-64 rounded-lg border border-linha bg-superficie p-3 text-ink shadow-lg md:bottom-0 md:left-12 md:right-auto"
            >
              <p className="font-medium">{me.displayName}</p>
              <p className="truncate text-sm text-muted">{me.email}</p>
              <p className="mt-2 text-xs text-muted">
                {semAcesso ? "Sem perfil de acesso" : `Perfis: ${me.profiles.join(", ")}`}
              </p>
              <button
                type="button"
                onClick={toggle}
                className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-superficie-2 md:hidden"
              >
                {dark ? <Sun size={16} /> : <Moon size={16} />} {dark ? "Tema claro" : "Tema escuro"}
              </button>
              {!semAcesso && <PrismaConexao />}
              {!semAcesso && (
                <button
                  type="button"
                  onClick={() => {
                    setNotificacoesAbertas(true);
                    setProfileOpen(false);
                  }}
                  className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-superficie-2"
                >
                  <BellRing size={16} /> Notificações e app
                </button>
              )}
              {!semAcesso && (
                <Link to="/conta/api" className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-superficie-2">
                  <KeyRound size={16} /> API e automações
                </Link>
              )}
              {!semAcesso && (
                <Link to="/conta/whatsapp" className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-superficie-2">
                  <Smartphone size={16} /> Meu WhatsApp
                </Link>
              )}
              <Link to="/termos" className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-superficie-2">
                <ShieldCheck size={16} /> Termo de uso e privacidade
              </Link>
              <form
                method="post"
                action="/auth/sair"
                onSubmit={(e) => {
                  // Antes de sair, este aparelho para de receber as notificações desta pessoa
                  // e apaga o histórico do WhatsApp baixado nele.
                  e.preventDefault();
                  const form = e.currentTarget;
                  void Promise.allSettled([desinscreverEsteAparelho(), apagarHistoricoDoAparelho()]).finally(() => form.submit());
                }}
              >
                <button
                  type="submit"
                  role="menuitem"
                  className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-vermelho hover:bg-superficie-2"
                >
                  <LogOut size={16} /> Sair
                </button>
              </form>
            </div>
          )}
        </div>
      </nav>

      {/* Lista */}
      <aside
        aria-label={current.label}
        className={`${centroAberto ? "hidden md:flex" : "flex"} min-h-0 flex-col border-linha bg-superficie md:border-r`}
      >
        <header className="px-4 pb-3 pt-4">
          <h1 className="text-xl font-semibold">{NA_CAIXA.includes(view) ? "Caixa" : current.label}</h1>
          {NA_CAIXA.includes(view) && !semAcesso && <FiltrosDaCaixa atual={view as FiltroCaixa} onFiltro={(f) => trocarView(f)} visiveis={NA_CAIXA.filter(vistaLiberada) as FiltroCaixa[]} />}
          {view !== "revisao" && (
          <label className="mt-3 flex items-center gap-2 rounded-md bg-superficie-2 px-3 py-2 text-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-azul focus-within:outline-solid">
            <Search size={16} aria-hidden />
            <input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={
                view === "missoes" ? "Buscar missão ou cliente…" : view === "tarefas" ? "Buscar projeto…" : view === "emails" ? "Buscar nos e-mails desta pasta…" : view === "tudo" ? "Buscar pessoa, e-mail, telefone…" : "Buscar cliente, missão, e-mail…"
              }
              aria-label="Buscar"
              className="w-full bg-transparent text-ink outline-none placeholder:text-muted"
            />
          </label>
          )}
        </header>
        {naTudo ? (
          <ListaUnica
            contatos={contatosUnicos}
            carregando={conversas.isPending || correspondentes.isPending}
            falha={conversas.isError ? conversas : correspondentes.isError ? correspondentes : null}
            selecionado={unico?.chave ?? null}
            onSelecionar={(chave) => {
              setCentroEmail(null);
              setContatoUnico(chave);
            }}
            busca={busca}
            missoesComNovidade={missoesComNovidade}
            onAbrirMissao={(id) => abrirMissao(id, "interno")}
            tarefas={tarefas.data ? { minhas: tarefas.data.minhas, atrasadas: tarefas.data.atrasadas } : null}
            onAbrirTarefas={() => trocarView("tarefas")}
          />
        ) : view === "emails" && !semAcesso ? (
          <EmailsLista
            busca={busca}
            selecionado={centroEmail?.tipo === "ler" ? centroEmail.id : null}
            onSelecionar={(id) => setCentroEmail({ tipo: "ler", id })}
            onEscrever={() => setCentroEmail({ tipo: "escrever", rascunho: { para: "", cc: "", cco: "", assunto: "", texto: "" } })}
          />
        ) : revisaoDados ? (
          <RevisaoNav dados={revisaoDados} filtro={filtroRevisao} onFiltro={setFiltroRevisao} />
        ) : view === "revisao" && veGestao && revisao.isError ? (
          <FalhaAoCarregar mensagem="Não foi possível carregar a revisão." consulta={revisao} className="px-6 py-10" />
        ) : view === "revisao" && veGestao ? (
          <p className="px-6 py-10 text-center text-muted">Montando a revisão…</p>
        ) : tarefasCtx ? (
          <TarefasNav ctx={tarefasCtx} vista={vistaTarefas} onVista={setVistaTarefas} busca={busca} />
        ) : view === "tarefas" && !semAcesso && tarefas.isError ? (
          <FalhaAoCarregar mensagem="Não foi possível carregar as tarefas." consulta={tarefas} className="px-6 py-10" />
        ) : view === "tarefas" && !semAcesso ? (
          <p className="px-6 py-10 text-center text-muted">Carregando tarefas…</p>
        ) : view === "missoes" && !semAcesso && missoes.data ? (
          <MissionList
            missoes={missoes.data}
            selecionada={missaoId}
            onSelecionar={setMissaoId}
            busca={busca}
            naoLidas={naoLidas.data ?? {}}
          />
        ) : view === "missoes" && !semAcesso && missoes.isError ? (
          <FalhaAoCarregar mensagem="Não foi possível carregar as missões." consulta={missoes} className="px-6 py-10" />
        ) : view === "missoes" && !semAcesso ? (
          <p className="px-6 py-10 text-center text-muted">Carregando missões…</p>
        ) : view === "conversas" && !semAcesso && conversas.data ? (
          <ListaConversas
            conversas={conversas.data}
            selecionada={conversaId}
            onSelecionar={(id) => {
              setCentroEmail(null);
              setConversaId(id);
            }}
            busca={busca}
          />
        ) : view === "conversas" && !semAcesso && conversas.isError ? (
          <FalhaAoCarregar mensagem="Não foi possível carregar as conversas." consulta={conversas} className="px-6 py-10" />
        ) : view === "conversas" && !semAcesso ? (
          <p className="px-6 py-10 text-center text-muted">Carregando conversas…</p>
        ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-muted">
          {semAcesso ? (
            <p>
              Seu acesso ainda não foi liberado.
              <br />A diretoria define o seu perfil no Omni.
            </p>
          ) : (
            <>
              <current.icon size={32} strokeWidth={1.6} aria-hidden />
              <p>{current.empty}</p>
            </>
          )}
        </div>
        )}
      </aside>

      {/* Conversa */}
      {revisaoDados ? (
        // A revisão usa também a coluna do contexto (tabela larga).
        <main className="flex min-h-0 flex-col bg-fundo xl:col-span-2">
          <RevisaoPainel dados={revisaoDados} filtro={filtroRevisao} onFiltro={setFiltroRevisao} onAbrirMissao={abrirMissao} />
        </main>
      ) : tarefasCtx ? (
        <main className={`${vistaTarefas ? "flex" : "hidden md:flex"} min-h-0 flex-col bg-fundo`}>
          <TarefasPainel
            ctx={tarefasCtx}
            vista={vistaTarefas ?? { tipo: "minhas" }}
            meuId={me.id}
            onVoltar={() => setVistaTarefas(null)}
          />
        </main>
      ) : (view === "emails" || view === "tudo" || (view === "conversas" && conversa)) && centroEmail ? (
        <main className="flex min-h-0 flex-col bg-fundo">
          <EmailsCentro
            estado={centroEmail}
            onFechar={() => setCentroEmail(null)}
            onEscrever={(rascunho) => setCentroEmail({ tipo: "escrever", rascunho })}
            onAbrirMissao={(id) => abrirMissao(id, "emails")}
            sugestoes={[]}
            voltarSempre={view === "tudo" || view === "conversas"}
          />
        </main>
      ) : conversa ? (
        <main className="flex min-h-0 flex-col bg-fundo">
          <PainelConversa
            key={conversa.id}
            conversa={conversa}
            contato={
              contatoDaConversa
                ? {
                    id: contatoDaConversa.contatoId,
                    enderecos: contatoDaConversa.enderecos,
                    onAbrirEmail: (id) => setCentroEmail({ tipo: "ler", id }),
                    onEscreverEmail: escreverEmail,
                  }
                : undefined
            }
            onVoltar={() => {
              setConversaId(null);
              setContatoUnico(null);
            }}
            onConcluida={() => {
              // Celular: volta para a lista. Tela larga: abre a próxima conversa aberta.
              const lista = (conversas.data ?? []).filter((c) => !c.concluida && c.id !== conversa.id);
              const atual = (conversas.data ?? []).findIndex((c) => c.id === conversa.id);
              const proxima = lista.find((c) => (conversas.data ?? []).indexOf(c) > atual) ?? lista[0];
              if (view === "tudo") setContatoUnico(null);
              else setConversaId(window.innerWidth >= 768 ? (proxima?.id ?? null) : null);
            }}
          />
        </main>
      ) : unico ? (
        <main className="flex min-h-0 flex-col bg-fundo">
          <PainelContatoEmail
            key={unico.chave}
            contato={unico}
            onVoltar={() => setContatoUnico(null)}
            onAbrirEmail={(id) => setCentroEmail({ tipo: "ler", id })}
            onEscreverEmail={escreverEmail}
          />
        </main>
      ) : missao ? (
        <main className="flex min-h-0 flex-col bg-fundo">
          <MissionDetail
            key={`${missao.id}-${abaMissao}`}
            abaInicial={abaMissao}
            missao={missao}
            onVoltar={() => setMissaoId(null)}
            meuId={me.id}
            souDiretoria={me.profiles.includes("diretoria")}
          />
        </main>
      ) : (
        <main className="hidden min-h-0 flex-col items-center justify-center gap-2 bg-fundo text-muted md:flex">
          <Target size={36} strokeWidth={1.4} aria-hidden />
          <p>Escolha uma conversa ou missão.</p>
        </main>
      )}

      {(view === "conversas" || view === "tudo") && <AvisoConversas />}
      {notificacoesAbertas && <NotificacoesApp fechar={() => setNotificacoesAbertas(false)} />}

      {tarefaDoAviso && tarefas.data && (
        <DetalheTarefa id={tarefaDoAviso} ctx={tarefas.data} meuId={me.id} onFechar={() => setTarefaDoAviso(null)} />
      )}

      {/* Painel do contexto (a revisão semanal ocupa este espaço) */}
      {!revisaoDados && (
      <aside aria-label="Contexto" className="hidden border-l border-linha bg-superficie xl:block">
        {tarefasCtx ? (
          <TarefasContexto ctx={tarefasCtx} vista={vistaTarefas ?? { tipo: "minhas" }} />
        ) : missao ? (
          <MissionContext missao={missao} />
        ) : conversa && !conversa.grupo && conversa.telefone ? (
          <div className="space-y-3 p-4">
            <p className="rotulo text-muted">Contexto</p>
            <p className="font-medium">{contatoDaConversa?.contatoId ? contatoDaConversa.nome : conversa.nome}</p>
            {contatoDaConversa?.empresa && <p className="text-sm text-muted">{contatoDaConversa.empresa}</p>}
            {contatoDaConversa && contatoDaConversa.enderecos.length > 0 && (
              <ul className="space-y-0.5 text-sm">
                {contatoDaConversa.enderecos.map((e) => (
                  <li key={e} className="truncate text-muted">
                    {e}
                  </li>
                ))}
              </ul>
            )}
            {contatoDaConversa && <ContatoEPrisma contato={contatoDaConversa} />}
            <NoPrismaInfo telefone={conversa.telefone} email={contatoDaConversa?.enderecos[0] ?? null} />
          </div>
        ) : unico ? (
          <div className="space-y-3 p-4">
            <p className="rotulo text-muted">Contexto</p>
            <p className="font-medium">{unico.nome}</p>
            {unico.empresa && <p className="text-sm text-muted">{unico.empresa}</p>}
            <ContatoEPrisma contato={unico} />
            <NoPrismaInfo email={unico.enderecos[0] ?? null} telefone={unico.telefones[0] ?? null} />
          </div>
        ) : (
          <div className="p-4">
            <p className="rotulo text-muted">Contexto</p>
            <p className="mt-2 text-muted">Cliente, missão ou colaborador da conversa aberta.</p>
          </div>
        )}
      </aside>
      )}
    </div>
  );
}
