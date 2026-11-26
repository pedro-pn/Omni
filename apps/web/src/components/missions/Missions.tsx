import {
  etapaInfo,
  etapaResumo,
  formatarCnpj,
  formatarJornada,
  PAPEIS_MISSAO,
  regimeTrabalho,
  tituloMissao,
} from "@omni/core";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CalendarClock,
  ClipboardList,
  FileText,
  FolderOpen,
  Layers,
  ListChecks,
  Lock,
  Mail,
  MapPin,
  MessageCircle,
  Shield,
  Users,
  Video,
} from "lucide-react";
import { useState } from "react";

import { getCanais } from "../../lib/canais-fns.ts";
import { listAgendaIA } from "../../lib/ia-fns.ts";
import {
  getPosCampo,
  listResponsaveis,
  type MissaoResumo,
} from "../../lib/missions-fns.ts";
import { TarefasDaMissao } from "../tarefas/TarefasDaMissao.tsx";
import { AlertasDaMissao } from "./AlertasMissao.tsx";
import { ArquivosDaMissao } from "./ArquivosMissao.tsx";
import { Canal } from "./Canal.tsx";
import { EmailsDaMissao, useEmailsDaMissao } from "./EmailsMissao.tsx";
import { GestaoDaMissao, useGestaoMissao } from "./GestaoMissao.tsx";
import { ReunioesDaMissao, useReunioesDaMissao } from "./ReunioesMissao.tsx";
import {
  RdosDaMissao,
  RelatoriosTecnicos,
  useRelatoriosDaMissao,
} from "./RelatoriosMissao.tsx";
import { TudoDaMissao } from "./TudoDaMissao.tsx";
import { ParticipantesMissao } from "./ParticipantesMissao.tsx";
import { AcessoMissao } from "./AcessoMissao.tsx";
import {
  useWhatsAppDaMissao,
  WhatsAppDaMissao,
} from "../conversas/Conversas.tsx";
import {
  AbasOrganizacao,
  filtrarPorAba,
  MenuOrganizar,
  useAbaOrganizacao,
  useOrganizacao,
} from "../organizacao/Organizacao.tsx";
import { Carregando } from "../comum/Carregando.tsx";

const dataCurta = (iso: string | null) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : "—";

const sincronizadoEm = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
      })
    : "nunca";

/** Agrupa por cliente; clientes com a missão mais recente primeiro (as missões já vêm por código decrescente). */
export function agruparPorCliente(
  missoes: MissaoResumo[],
): Array<[string, MissaoResumo[]]> {
  const grupos = new Map<string, MissaoResumo[]>();
  for (const m of missoes) {
    const lista = grupos.get(m.clientName) ?? [];
    lista.push(m);
    grupos.set(m.clientName, lista);
  }
  return [...grupos.entries()];
}

function Avanco({ valor }: { valor: number | null }) {
  if (valor === null) return null;
  const pct = Math.max(0, Math.min(100, valor));
  return (
    <div
      className="mt-1.5 flex items-center gap-2"
      aria-label={`Avanço ${pct.toLocaleString("pt-BR")}%`}
    >
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-superficie-2">
        <div
          className="h-full rounded-full bg-floresta"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-muted">
        {Math.round(pct)}%
      </span>
    </div>
  );
}

export function MissionList({
  missoes,
  selecionada,
  onSelecionar,
  busca,
  naoLidas,
}: {
  missoes: MissaoResumo[];
  selecionada: string | null;
  onSelecionar: (id: string) => void;
  busca: string;
  naoLidas: Record<string, { interno: number; gerencial: number }>;
}) {
  const termo = busca.trim().toLowerCase();
  const org = useOrganizacao("missao");
  const [aba, setAba] = useAbaOrganizacao("missao");
  // A busca procura em tudo, inclusive nas arquivadas; sem busca, vale a aba escolhida.
  const filtradas = termo
    ? missoes.filter(
        (m) =>
          m.code.includes(termo) || m.clientName.toLowerCase().includes(termo),
      )
    : filtrarPorAba(missoes, (m) => m.id, org.data, aba);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!termo && <AbasOrganizacao tipo="missao" aba={aba} onAba={setAba} />}
      {filtradas.length === 0 ? (
        <p className="px-6 py-10 text-center text-muted">
          {termo
            ? "Nenhuma missão encontrada."
            : aba === "arquivadas"
              ? "Nenhuma missão arquivada."
              : aba !== "todas"
                ? "Nenhuma missão nesta pasta. Use o menu ⋮ de uma missão para pôr aqui."
                : "Nenhuma missão ativa."}
        </p>
      ) : (
        <ul className="flex-1 overflow-y-auto pb-4">
          {agruparPorCliente(filtradas).map(([cliente, lista]) => (
            <li key={cliente}>
              {lista.length > 1 && (
                <p className="rotulo px-4 pb-1 pt-3 text-muted">{cliente}</p>
              )}
              <ul>
                {lista.map((m) => {
                  const etapa = etapaInfo(m.stage);
                  const ativa = m.id === selecionada;
                  return (
                    <li key={m.id} className="relative">
                      <button
                        type="button"
                        onClick={() => onSelecionar(m.id)}
                        aria-current={ativa ? "true" : undefined}
                        className={`flex w-full gap-3 border-b border-linha py-3 pl-4 pr-10 text-left hover:bg-superficie-2 ${ativa ? "bg-floresta-clara" : ""}`}
                      >
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-floresta text-white">
                          <Users size={20} strokeWidth={1.9} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate font-medium">
                              {tituloMissao(m.code, m.clientName)}
                            </span>
                            {(m.criticalIssueCount ?? 0) > 0 && (
                              <span
                                title="Pendências críticas"
                                className="flex shrink-0 items-center gap-0.5 text-xs text-vermelho"
                              >
                                <AlertTriangle size={13} aria-hidden />{" "}
                                {m.criticalIssueCount}
                              </span>
                            )}
                          </span>
                          <span className="flex items-center justify-between gap-2">
                            <span
                              className={`truncate text-sm ${etapa ? "text-azul" : "text-muted"}`}
                            >
                              {etapaResumo(m.stage)}
                            </span>
                            <span className="flex shrink-0 gap-1">
                              {(naoLidas[m.id]?.interno ?? 0) > 0 && (
                                <span
                                  title="Mensagens novas no Interno"
                                  className="flex items-center gap-0.5 rounded-full bg-lilas px-1.5 text-xs font-semibold text-white"
                                >
                                  <Lock size={11} aria-hidden />{" "}
                                  {naoLidas[m.id]!.interno}
                                </span>
                              )}
                              {(naoLidas[m.id]?.gerencial ?? 0) > 0 && (
                                <span
                                  title="Mensagens novas no Gerencial"
                                  className="flex items-center gap-0.5 rounded-full bg-azul px-1.5 text-xs font-semibold text-white"
                                >
                                  <Shield size={11} aria-hidden />{" "}
                                  {naoLidas[m.id]!.gerencial}
                                </span>
                              )}
                            </span>
                          </span>
                          <Avanco valor={m.progressPercent} />
                        </span>
                      </button>
                      <div className="absolute right-2 top-2.5">
                        <MenuOrganizar
                          tipo="missao"
                          itemId={m.id}
                          nome={tituloMissao(m.code, m.clientName)}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{rotulo}</dt>
      <dd className="font-medium">{valor}</dd>
    </div>
  );
}

type Aba =
  | "resumo"
  | "tudo"
  | "interno"
  | "gerencial"
  | "tarefas"
  | "whatsapp"
  | "emails"
  | "reunioes"
  | "rdos"
  | "relatorios"
  | "arquivos"
  | "gestao";
const ABAS_VALIDAS: Aba[] = [
  "resumo",
  "tudo",
  "interno",
  "gerencial",
  "tarefas",
  "whatsapp",
  "emails",
  "reunioes",
  "rdos",
  "relatorios",
  "arquivos",
  "gestao",
];

const quando = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });

/** Próximas perguntas da IA na missão, com o motivo da data (INSTRUCOES §6.7). */
function AgendaIA({
  missionId,
  cicloEncerradoEm,
}: {
  missionId: string;
  cicloEncerradoEm: string | null;
}) {
  const agenda = useQuery({
    queryKey: ["agenda-ia", missionId],
    queryFn: () => listAgendaIA({ data: { missionId } }),
  });
  if (cicloEncerradoEm) {
    return (
      <section className="mt-4 rounded-lg border border-linha bg-superficie p-5">
        <p className="rotulo flex items-center gap-1.5 text-muted">
          <CalendarClock size={14} aria-hidden /> Agenda da IA
        </p>
        <p className="mt-2 text-sm text-muted">
          Ciclo encerrado no Omni em {quando(cicloEncerradoEm)}. A IA não
          acompanha mais esta missão.
        </p>
      </section>
    );
  }
  if (!agenda.data) return null;
  return (
    <section className="mt-4 rounded-lg border border-linha bg-superficie p-5">
      <p className="rotulo flex items-center gap-1.5 text-muted">
        <CalendarClock size={14} aria-hidden /> Agenda da IA
      </p>
      {agenda.data.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          Nenhuma pergunta agendada. A IA só envia de segunda a sexta, das 8h às
          18h, fora de feriados.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-linha">
          {agenda.data.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
            >
              <span className="font-medium">{a.titulo}</span>
              <span className="text-muted">
                {quando(a.quando)}
                {a.motivo ? ` · ${a.motivo}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const diaBr = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
      })
    : "—";

const SITUACAO_MEDICAO: Record<string, string> = {
  SEM_MEDICAO: "Ainda não registrada no filtroAPP",
  PREPARADA: "Preparada",
  ENVIADA: "Enviada ao cliente",
  APROVADA: "Aprovada pelo cliente",
};
const RECEBIMENTO: Record<string, string> = {
  RECEBIDA: "recebida",
  PARCIAL: "recebida em parte",
  EM_ABERTO: "a receber",
  ATRASADA: "recebimento atrasado",
  DESCONHECIDA: "recebimento sem informação",
};

/** O que o filtroAPP sabe depois do campo: medição, notas, romaneios/descarga e pendências (sem valores). */
function PosCampoBloco({ missionId }: { missionId: string }) {
  const pos = useQuery({
    queryKey: ["pos-campo", missionId],
    queryFn: () => getPosCampo({ data: { missionId } }),
  });
  const d = pos.data;
  if (
    !d ||
    (!d.medicao && !d.notas.length && !d.romaneios.length && !d.pendencias)
  )
    return null;
  const pendente =
    d.pendencias && (d.pendencias.aPagar > 0 || d.pendencias.aReceber > 0);
  return (
    <section className="mt-4 rounded-lg border border-linha bg-superficie p-5 text-sm">
      <p className="rotulo text-muted">
        Medição, faturamento e logística · filtroAPP
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-muted">Medição</dt>
          <dd>
            {d.medicao ? SITUACAO_MEDICAO[d.medicao.situacao] : "Sem registro"}
            {d.medicao?.aprovadaEm
              ? ` em ${diaBr(d.medicao.aprovadaEm)}`
              : d.medicao?.enviadaEm
                ? ` em ${diaBr(d.medicao.enviadaEm)}`
                : ""}
            {d.medicao?.saldoPendente ? (
              <span className="block text-vermelho">
                Aprovada sem o saldo completo
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Pendências no Omie</dt>
          <dd>
            {!d.pendencias
              ? "Sem informação"
              : pendente
                ? `${d.pendencias.aPagar} a pagar · ${d.pendencias.aReceber} a receber${d.pendencias.proximoVencimento ? ` · próximo vencimento ${diaBr(d.pendencias.proximoVencimento)}` : ""}`
                : "Nenhuma"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Notas fiscais · {d.notas.length}</dt>
          <dd>
            {d.notas.length === 0 ? (
              "Nenhuma ligada à missão"
            ) : (
              <ul className="grid gap-0.5">
                {d.notas.slice(0, 5).map((n) => (
                  <li key={n.id}>
                    {n.tipo === "NFSE"
                      ? "NFS-e"
                      : n.tipo === "NFE"
                        ? "NF-e"
                        : "ND"}{" "}
                    {n.numero} · {diaBr(n.emissao)} ·{" "}
                    {RECEBIMENTO[n.recebimento]}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Romaneios · {d.romaneios.length}</dt>
          <dd>
            {d.romaneios.length === 0 ? (
              "Nenhum"
            ) : (
              <ul className="grid gap-0.5">
                {d.romaneios.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    {r.tipo === "SAIDA" ? "Saída" : "Retorno"} · {diaBr(r.data)}{" "}
                    · {r.itens} itens
                    {r.tipo === "SAIDA" && (
                      <span className="text-muted">
                        {" "}
                        ·{" "}
                        {r.descarga
                          ? `descarga ${r.descarga.tipo === "TOTAL" ? "total" : "parcial"} em ${diaBr(r.descarga.em)}`
                          : "descarga não confirmada"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="ml-1.5 rounded-full bg-floresta px-1.5 text-xs font-semibold text-white">
      {n}
    </span>
  );
}

export function MissionDetail({
  missao,
  onVoltar,
  meuId,
  souDiretoria,
  abaInicial = "resumo",
}: {
  missao: MissaoResumo;
  onVoltar: () => void;
  meuId: string;
  souDiretoria: boolean;
  /** Aba aberta ao chegar por um aviso ou notificação (ex.: "interno"). */
  abaInicial?: string;
}) {
  const etapa = etapaInfo(missao.stage);
  const [aba, setAba] = useState<Aba>(
    ABAS_VALIDAS.includes(abaInicial as Aba) ? (abaInicial as Aba) : "resumo",
  );
  const canais = useQuery({
    queryKey: ["canais", missao.id],
    queryFn: () => getCanais({ data: { missionId: missao.id } }),
  });
  const interno = canais.data?.find((c) => c.channel === "interno");
  const gerencial = canais.data?.find((c) => c.channel === "gerencial");
  // Gestão: gerente, diretoria e quem vê o Interno (o banco decide).
  const gestao = useGestaoMissao(missao.id);
  // E-mails: diretoria e gerentes (o banco decide).
  const emails = useEmailsDaMissao(missao.id);
  // Reuniões do Teams: mesma regra dos e-mails.
  const reunioes = useReunioesDaMissao(missao.id);
  // RDOs e relatórios técnicos do filtroAPP (quem tem perfil lê; pontos da IA só para quem vê o Interno).
  const relatorios = useRelatoriosDaMissao(missao.id);
  // WhatsApp: grupos ligados à missão que a pessoa pode ler (o banco decide).
  const whatsapp = useWhatsAppDaMissao(missao.id);
  const abas: Array<{
    id: Aba;
    rotulo: string;
    icone?: typeof Lock;
    n?: number;
  }> = [
    { id: "resumo", rotulo: "Resumo" },
    { id: "tudo", rotulo: "Tudo", icone: Layers },
    ...(interno?.acesso
      ? [
          {
            id: "interno" as const,
            rotulo: "Interno",
            icone: Lock,
            n: interno.naoLidas,
          },
        ]
      : []),
    ...(gerencial?.acesso
      ? [
          {
            id: "gerencial" as const,
            rotulo: "Gerencial",
            icone: Shield,
            n: gerencial.naoLidas,
          },
        ]
      : []),
    // Tarefas da missão: para quem vê o Interno (mesma regra no banco).
    ...(interno?.acesso
      ? [{ id: "tarefas" as const, rotulo: "Tarefas", icone: ListChecks }]
      : []),
    ...(whatsapp.data?.length
      ? [{ id: "whatsapp" as const, rotulo: "WhatsApp", icone: MessageCircle }]
      : []),
    ...(emails.data?.podeVer
      ? [{ id: "emails" as const, rotulo: "E-mails", icone: Mail }]
      : []),
    ...(reunioes.data?.podeVer
      ? [{ id: "reunioes" as const, rotulo: "Reuniões", icone: Video }]
      : []),
    ...(relatorios.data?.rdos.length
      ? [{ id: "rdos" as const, rotulo: "RDOs", icone: ClipboardList }]
      : []),
    ...(relatorios.data?.tecnicos.length
      ? [{ id: "relatorios" as const, rotulo: "Relatórios", icone: FileText }]
      : []),
    // Arquivos: a lista vem filtrada pelo banco (cada pessoa vê só as pastas que pode).
    { id: "arquivos", rotulo: "Arquivos", icone: FolderOpen },
    ...(gestao.data?.podeVer
      ? [{ id: "gestao" as const, rotulo: "Gestão", icone: BarChart3 }]
      : []),
  ];
  const canalAtual =
    aba === "interno" ? interno : aba === "gerencial" ? gerencial : undefined;
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
        <span className="flex size-10 items-center justify-center rounded-full bg-floresta text-white">
          <Users size={18} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-semibold">
            {tituloMissao(missao.code, missao.clientName)}
          </h2>
          <p className="truncate text-sm text-muted">
            {etapaResumo(missao.stage)}
          </p>
        </div>
      </header>
      <nav
        aria-label="Abas da missão"
        className="flex gap-1 overflow-x-auto border-b border-linha bg-superficie px-3"
      >
        {abas.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAba(a.id)}
            aria-current={aba === a.id ? "page" : undefined}
            className={`flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              aba === a.id
                ? "border-floresta text-floresta-texto"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {a.icone && <a.icone size={14} aria-hidden />}
            {a.rotulo}
            <Badge n={a.n ?? 0} />
          </button>
        ))}
      </nav>

      {aba === "tudo" ? (
        <TudoDaMissao
          key={missao.id}
          missionId={missao.id}
          abrirAba={(a) => ABAS_VALIDAS.includes(a as Aba) && setAba(a as Aba)}
        />
      ) : aba === "tarefas" && interno?.acesso ? (
        <TarefasDaMissao key={missao.id} missionId={missao.id} meuId={meuId} />
      ) : aba === "emails" && emails.data?.podeVer ? (
        <EmailsDaMissao
          key={missao.id}
          missionId={missao.id}
          missionCode={missao.code}
          podeComentar={Boolean(interno?.acesso)}
        />
      ) : aba === "whatsapp" && whatsapp.data?.length ? (
        <WhatsAppDaMissao key={missao.id} missionId={missao.id} />
      ) : aba === "reunioes" && reunioes.data?.podeVer ? (
        <ReunioesDaMissao key={missao.id} missionId={missao.id} />
      ) : aba === "rdos" ? (
        <RdosDaMissao key={missao.id} missionId={missao.id} />
      ) : aba === "relatorios" ? (
        <RelatoriosTecnicos key={missao.id} missionId={missao.id} />
      ) : aba === "arquivos" ? (
        <ArquivosDaMissao key={missao.id} missionId={missao.id} />
      ) : aba === "gestao" && gestao.data?.podeVer ? (
        <GestaoDaMissao key={missao.id} missionId={missao.id} />
      ) : canalAtual && (aba === "interno" || aba === "gerencial") ? (
        <Canal
          key={`${missao.id}-${aba}`}
          missionId={missao.id}
          channel={aba}
          meuId={meuId}
          podeGerenciar={canalAtual.podeGerenciar}
          souDiretoria={souDiretoria}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-5">
          <AlertasDaMissao missionId={missao.id} />
          <section className="rounded-lg border border-linha bg-superficie p-5">
            <p className="rotulo text-muted">Acompanhamento · filtroAPP</p>
            {etapa ? (
              <ol
                className="mt-3 flex gap-1"
                aria-label={`Etapa ${etapa.posicao} de ${etapa.total}`}
              >
                {Array.from({ length: etapa.total }, (_, i) => (
                  <li
                    key={i}
                    className={`h-1.5 flex-1 rounded-full ${i < etapa.posicao ? "bg-floresta" : "bg-superficie-2"}`}
                  />
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-muted">
                Esta missão ainda não tem acompanhamento iniciado no filtroAPP.
              </p>
            )}
            <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Campo
                rotulo="Avanço"
                valor={
                  missao.progressPercent === null
                    ? "—"
                    : `${Math.round(missao.progressPercent)}%`
                }
              />
              <Campo
                rotulo="Mobilização (comercial)"
                valor={dataCurta(missao.commercialExpectedMobilizationDate)}
              />
              <Campo
                rotulo="Mobilização planejada"
                valor={dataCurta(missao.plannedMobilizationDate)}
              />
              <Campo
                rotulo="Mobilização real"
                valor={dataCurta(missao.actualMobilizationDate)}
              />
              <Campo
                rotulo="Início em campo"
                valor={dataCurta(missao.startedAt)}
              />
              <Campo
                rotulo="Desmobilização"
                valor={dataCurta(missao.demobilizationDate)}
              />
            </dl>
            <ProntidaoDaEtapa missao={missao} />
          </section>

          <PosCampoBloco missionId={missao.id} />
          {interno?.acesso && (
            <AgendaIA
              missionId={missao.id}
              cicloEncerradoEm={missao.cicloEncerradoEm}
            />
          )}
          {interno?.acesso && (
            <div className="mt-5">
              <ParticipantesMissao missionId={missao.id} />
            </div>
          )}
          <div className="mt-5">
            <AcessoMissao missionId={missao.id} />
          </div>
        </div>
      )}
    </div>
  );
}

function Responsaveis({ missionId }: { missionId: string }) {
  const responsaveis = useQuery({
    queryKey: ["responsaveis", missionId],
    queryFn: () => listResponsaveis({ data: { missionId } }),
  });
  if (responsaveis.isPending)
    return <Carregando rotulo="Carregando responsáveis" />;
  if (responsaveis.isError)
    return (
      <p className="text-sm text-vermelho">
        Não foi possível carregar os responsáveis.
      </p>
    );
  if (responsaveis.data.length === 0)
    return (
      <p className="text-sm text-muted">
        Nenhum responsável definido no filtroAPP.
      </p>
    );
  return (
    <ul className="space-y-3">
      {responsaveis.data.map((r) => (
        <li key={r.role}>
          <p className="rotulo text-muted">{PAPEIS_MISSAO[r.role]}</p>
          <p className="font-medium">{r.name}</p>
          <p className="text-xs text-muted">
            {r.personId
              ? "Usa o Omni"
              : r.email
                ? "Ainda não entrou no Omni"
                : "Sem e-mail corporativo · só WhatsApp"}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function MissionContext({ missao }: { missao: MissaoResumo }) {
  const regime = regimeTrabalho(missao.includesSaturday, missao.includesSunday);
  return (
    <div className="space-y-4 overflow-y-auto p-4">
      <p className="rotulo text-muted">Missão</p>
      <div className="rounded-lg border border-linha p-4">
        <p className="font-semibold">
          {missao.clientLegalName ?? missao.clientName}
        </p>
        {missao.clientCnpj && (
          <p className="text-sm tabular-nums text-muted">
            CNPJ {formatarCnpj(missao.clientCnpj)}
          </p>
        )}
        {missao.location && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
            <MapPin size={14} aria-hidden /> {missao.location}
          </p>
        )}
        {missao.clientSegment && (
          <p className="mt-2 inline-block rounded-sm bg-superficie-2 px-2 py-0.5 text-xs">
            {missao.clientSegment}
          </p>
        )}
        <dl className="mt-3 space-y-1 border-t border-linha pt-3 text-sm">
          {missao.commercialProposalCode && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Proposta</dt>
              <dd className="tabular-nums">{missao.commercialProposalCode}</dd>
            </div>
          )}
          {regime && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Regime</dt>
              <dd>
                {regime}
                {formatarJornada(missao.workdayHours)
                  ? ` · ${formatarJornada(missao.workdayHours)}`
                  : ""}
              </dd>
            </div>
          )}
          {missao.executedAtHeadquarters !== null && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Local</dt>
              <dd>{missao.executedAtHeadquarters ? "Na sede" : "Em campo"}</dd>
            </div>
          )}
        </dl>
      </div>

      <p className="rotulo text-muted">Responsáveis</p>
      <div className="rounded-lg border border-linha p-4">
        <Responsaveis missionId={missao.id} />
      </div>
      <p className="text-xs text-muted">
        Atualizado do filtroAPP em {sincronizadoEm(missao.statusSyncedAt)}.
      </p>
    </div>
  );
}

/**
 * Prontidão da etapa no filtroAPP (o que a API entrega: liberações e contagem de
 * pendências; os itens do checklist ficam no filtroAPP).
 */
function ProntidaoDaEtapa({ missao }: { missao: MissaoResumo }) {
  if (!missao.workflowStarted) return null;
  const item = (rotulo: string, ok: boolean | null, sim: string, nao: string) => (
    <li className="flex items-center gap-2">
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${ok === null ? "bg-superficie-2 text-muted" : ok ? "bg-floresta text-white" : "bg-vermelho/15 text-vermelho"}`}
        aria-hidden
      >
        {ok === null ? "?" : ok ? "✓" : "!"}
      </span>
      <span>
        <span className="text-muted">{rotulo}:</span> {ok === null ? "sem informação" : ok ? sim : nao}
      </span>
    </li>
  );
  const comercial = missao.commercialReadiness === "RELEASED" ? true : missao.commercialReadiness === "NOT_RELEASED" ? false : null;
  const abertas = missao.openIssueCount ?? 0;
  const criticas = missao.criticalIssueCount ?? 0;
  return (
    <div className="mt-5 border-t border-linha pt-4">
      <p className="rotulo mb-2 text-muted">Prontidão da etapa</p>
      <ul className="grid gap-2 text-sm sm:grid-cols-2">
        {item("Comercial", comercial, "liberado", "pendente")}
        {missao.actualMobilizationDate
          ? item("Mobilização", true, `realizada em ${dataCurta(missao.actualMobilizationDate)}`, "")
          : item("Mobilização", missao.mobilizationReady, "liberada", "com pendências")}
        {/* Encerramento só depois do início em campo (antes, "com pendências" é o normal). */}
        {missao.startedAt && item("Encerramento", missao.closureReady, "liberado", "com pendências")}
        <li className="flex items-center gap-2">
          <span
            className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${criticas ? "bg-vermelho text-white" : abertas ? "bg-superficie-2 text-ink" : "bg-floresta text-white"}`}
            aria-hidden
          >
            {abertas || "✓"}
          </span>
          <span>
            <span className="text-muted">Pendências:</span>{" "}
            {abertas ? `${abertas} aberta${abertas === 1 ? "" : "s"}${criticas ? `, ${criticas} crítica${criticas === 1 ? "" : "s"}` : ""}` : "nenhuma aberta"}
          </span>
        </li>
      </ul>
      {(abertas > 0 || comercial === false || missao.mobilizationReady === false) && (
        <p className="mt-2 text-xs text-muted">Os itens de cada pendência ficam no filtroAPP (Acompanhamento do projeto).</p>
      )}
    </div>
  );
}

