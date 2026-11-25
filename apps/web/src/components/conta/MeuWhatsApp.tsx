import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import {
  atualizarEstadoNumero,
  desconectarNumero,
  parearNumero,
  reconfigurarNumero,
  removerNumero,
  meusNumeros,
  prepararHistorico,
  type NumeroWhatsApp,
} from "../../lib/whatsapp-fns.ts";
import { ConectarWhatsApp } from "../conversas/Conversas.tsx";
import {
  Aviso,
  botaoPrimario,
  botaoSecundario,
  mensagemDeErro,
} from "../admin/ui.tsx";
import { apagarHistoricoDoAparelho, sincronizarHistorico, useProgressoDoHistorico } from "../../lib/whatsapp-aparelho.ts";

const STATUS: Record<NumeroWhatsApp["status"], { texto: string; cor: string }> =
  {
    criado: { texto: "Ainda não pareado", cor: "text-muted" },
    conectando: { texto: "Aguardando o QR code", cor: "text-azul" },
    conectado: { texto: "Conectado", cor: "text-floresta-texto" },
    desconectado: { texto: "Desconectado", cor: "text-vermelho" },
    removido: { texto: "Removido", cor: "text-muted" },
  };
const ENVIO = {
  desligado: "desligado",
  ensaio: "em ensaio (as mensagens são registradas, mas não saem)",
  real: "real",
};

const telefone = (t: string | null) =>
  t
    ? `+${t.slice(0, 2)} ${t.slice(2, 4)} ${t.slice(4, -4)}-${t.slice(-4)}`
    : null;

/**
 * Meu WhatsApp (Evolution própria do Omni, pareamento por QR code — ADR 0004): o
 * próprio número, com as ações sobre o aparelho. Só o dono mexe nele; a
 * Administração não tem acesso aos números das pessoas (0056).
 */
export function MeuWhatsApp({ personId }: { personId: string }) {
  const qc = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const [pareando, setPareando] = useState<NumeroWhatsApp | null>(null);
  const [historico, setHistorico] = useState<NumeroWhatsApp | null>(null);
  // Sem número: o QR code só aparece no clique (remover não pode reconectar sozinho).
  const [conectar, setConectar] = useState(false);
  const chave = ["whatsapp", "meus"];
  const painel = useQuery({ queryKey: chave, queryFn: () => meusNumeros() });
  const atualizar = () => {
    void qc.invalidateQueries({ queryKey: chave });
    void qc.invalidateQueries({ queryKey: ["whatsapp", "meu"] });
  };
  const acao = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });

  if (painel.isPending) return <p className="text-muted">Carregando…</p>;
  if (painel.isError)
    return <Aviso tipo="erro">{mensagemDeErro(painel.error)}</Aviso>;
  const p = painel.data;
  return (
    <section className="space-y-4">
      <p className="text-muted">
        O seu número de WhatsApp no Omni. Só você vê as conversas dele (nem a
        Administração nem a diretoria). Não conecte aqui um número que esteja no
        Prisma: cada número fica em um sistema só. O envio está{" "}
        <b>{ENVIO[p.envio]}</b>. Mensagens do Interno e do Gerencial nunca saem
        pelo WhatsApp.
      </p>
      {!p.configurado && (
        <Aviso tipo="erro">
          O WhatsApp ainda não foi configurado neste ambiente.
        </Aviso>
      )}
      {erro && <Aviso tipo="erro">{erro}</Aviso>}

      {p.numeros.length === 0 && p.configurado && (
        <div className="flex justify-center rounded-lg border border-linha bg-superficie">
          {conectar ? (
            <ConectarWhatsApp automatico onFechar={() => setConectar(false)} />
          ) : (
            <div className="space-y-3 p-6 text-center">
              <p>Você ainda não conectou o seu WhatsApp ao Omni.</p>
              <button
                type="button"
                onClick={() => setConectar(true)}
                className={`${botaoPrimario} inline-flex items-center gap-1`}
              >
                <QrCode size={16} aria-hidden /> Conectar meu WhatsApp
              </button>
            </div>
          )}
        </div>
      )}
      <ul className="space-y-3">
        {p.numeros.map((n) => (
          <CartaoNumero
            key={n.id}
            n={n}
            ocupado={acao.isPending}
            acao={(f) => acao.mutate(f)}
            parear={() => setPareando(n)}
            historico={() => setHistorico(n)}
          />
        ))}
      </ul>
      {historico && (
        <DialogoHistorico
          numero={historico}
          personId={personId}
          parear={() => {
            setPareando(historico);
            setHistorico(null);
          }}
          fechar={() => {
            setHistorico(null);
            atualizar();
          }}
        />
      )}
      {pareando && (
        <DialogoPareamento
          numero={pareando}
          fechar={() => {
            setPareando(null);
            atualizar();
          }}
        />
      )}
    </section>
  );
}

function CartaoNumero({
  n,
  ocupado,
  acao,
  parear,
  historico,
}: {
  n: NumeroWhatsApp;
  ocupado: boolean;
  acao: (f: () => Promise<unknown>) => void;
  parear: () => void;
  historico: () => void;
}) {
  const s = STATUS[n.status];
  const remover = (
    <button
      type="button"
      disabled={ocupado}
      onClick={() =>
        confirm(
          "Remover o seu WhatsApp do Omni? As mensagens novas param de chegar; as conversas já recebidas continuam guardadas. O histórico baixado neste aparelho é apagado. Para voltar, conecte de novo.",
        ) &&
        acao(async () => {
          const r = await removerNumero({ data: { id: n.id } });
          await apagarHistoricoDoAparelho();
          return r;
        })
      }
      className={`${botaoSecundario} text-vermelho`}
    >
      Remover
    </button>
  );
  return (
    <li className="rounded-lg border border-linha bg-superficie p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold">
            <Smartphone size={16} aria-hidden /> {n.rotulo}
          </p>
          <p className="text-sm">
            <span className={s.cor}>{s.texto}</span>
            {n.telefone && (
              <span className="text-muted"> · {telefone(n.telefone)}</span>
            )}
            {n.perfil && <span className="text-muted"> · {n.perfil}</span>}
          </p>
          <p className="text-xs text-muted">
            Gravar ligações:{" "}
            {n.podeGravar
              ? "permitido pela Administração"
              : "não permitido (fale com a Administração)"}
            .
          </p>
          {n.erro && <p className="mt-1 text-sm text-vermelho">{n.erro}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <>
            {n.status !== "conectado" && (
              <button
                type="button"
                onClick={parear}
                disabled={ocupado}
                className={`${botaoPrimario} flex items-center gap-1`}
              >
                <QrCode size={14} aria-hidden /> Conectar
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                acao(() => atualizarEstadoNumero({ data: { id: n.id } }))
              }
              disabled={ocupado}
              className={`${botaoSecundario} flex items-center gap-1`}
            >
              <RefreshCw size={14} aria-hidden /> Atualizar
            </button>
            <button
              type="button"
              onClick={historico}
              disabled={ocupado}
              className={`${botaoSecundario} flex items-center gap-1`}
            >
              <History size={14} aria-hidden /> Histórico
            </button>
            <button
              type="button"
              onClick={() =>
                acao(() => reconfigurarNumero({ data: { id: n.id } }))
              }
              disabled={ocupado}
              className={botaoSecundario}
            >
              Reconfigurar
            </button>
            {n.status === "conectado" && (
              <button
                type="button"
                disabled={ocupado}
                onClick={() =>
                  confirm(
                    "Desconectar o seu WhatsApp do Omni? Para voltar, será preciso ler o QR code de novo.",
                  ) && acao(() => desconectarNumero({ data: { id: n.id } }))
                }
                className={botaoSecundario}
              >
                Desconectar
              </button>
            )}
          </>
          {remover}
        </div>
      </div>
    </li>
  );
}

/** Mostra o QR code da Evolution e atualiza a cada 5 s até o aparelho conectar. */
function DialogoPareamento({
  numero,
  fechar,
}: {
  numero: NumeroWhatsApp;
  fechar: () => void;
}) {
  const q = useQuery({
    queryKey: ["admin", "whatsapp", "parear", numero.id],
    queryFn: () => parearNumero({ data: { id: numero.id } }),
    refetchInterval: (query) =>
      query.state.data?.estado === "conectado" ? false : 5000,
    retry: false,
  });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [fechar]);
  const conectado = q.data?.estado === "conectado";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-parear"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-md space-y-4 rounded-lg bg-superficie p-5 shadow-xl">
        <h2 id="titulo-parear" className="text-lg font-semibold">
          Parear "{numero.rotulo}"
        </h2>
        {conectado ? (
          <Aviso tipo="ok">
            Conectado
            {q.data?.telefone ? ` ao ${telefone(q.data.telefone)}` : ""}. As
            mensagens novas passam a chegar no Omni.
          </Aviso>
        ) : (
          <>
            <ol className="ml-5 list-decimal space-y-1 text-sm">
              <li>No celular do número, abra o WhatsApp.</li>
              <li>
                Toque em{" "}
                <b>⋮ → Dispositivos conectados → Conectar dispositivo</b> (no
                iPhone: Configurações → Dispositivos conectados).
              </li>
              <li>Aponte a câmera para o código abaixo.</li>
            </ol>
            <div className="flex min-h-64 items-center justify-center rounded-md bg-white p-3">
              {q.isPending && (
                <p className="text-sm text-neutral-600">Gerando o QR code…</p>
              )}
              {q.isError && (
                <p className="text-sm text-vermelho">
                  {mensagemDeErro(q.error)}
                </p>
              )}
              {q.data?.imagem && (
                <img
                  src={q.data.imagem}
                  alt="QR code para parear o WhatsApp"
                  className="size-64"
                />
              )}
              {q.data && !q.data.imagem && (
                <p className="text-sm text-neutral-600">
                  Aguardando a Evolution gerar um novo código…
                </p>
              )}
            </div>
            <p className="text-xs text-muted">
              O código muda sozinho a cada poucos segundos. Não compartilhe esta
              tela: quem ler o código conecta o número.
            </p>
          </>
        )}
        <div className="flex justify-end">
          <button type="button" onClick={fechar} className={botaoPrimario}>
            {conectado ? "Concluir" : "Fechar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Histórico no aparelho (como o WhatsApp Web): o Omni baixa para este navegador o
 * histórico que o celular mandou no pareamento; o servidor não guarda as mensagens
 * antigas. Parear de novo pede o histórico outra vez ao celular.
 */
function DialogoHistorico({
  numero,
  personId,
  parear,
  fechar,
}: {
  numero: NumeroWhatsApp;
  personId: string;
  parear: () => void;
  fechar: () => void;
}) {
  const qc = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const progresso = useProgressoDoHistorico();
  const deste = progresso.numberId === numero.id;
  const preparar = useMutation({
    mutationFn: () => prepararHistorico({ data: { id: numero.id } }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSuccess: parear,
  });
  const reler = () => void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] });
  const pct = deste && progresso.paginas ? Math.min(100, Math.round((progresso.pagina / progresso.paginas) * 100)) : null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="titulo-historico" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90dvh] w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-lg bg-superficie p-5 shadow-xl">
        <h2 id="titulo-historico" className="text-lg font-semibold">
          Histórico de "{numero.rotulo}"
        </h2>
        <p className="text-sm text-muted">
          Como no WhatsApp Web, o histórico de <b>todas as conversas</b> é baixado para <b>este aparelho</b> e fica só nele. O servidor do Omni não
          guarda as mensagens antigas. Em outro computador ou celular, o histórico é baixado de novo. Ao sair do Omni, ele é apagado deste aparelho.
        </p>
        {erro && <Aviso tipo="erro">{erro}</Aviso>}
        <section className="rounded-md border border-linha p-3 text-sm" aria-live="polite">
          <p className="font-medium">Neste aparelho</p>
          {!deste || progresso.fase === "parado" ? (
            <p className="text-muted">A cópia começa sozinha quando o Omni está aberto.</p>
          ) : progresso.fase === "outraAba" ? (
            <p className="text-muted">Baixando em outra aba do Omni.</p>
          ) : progresso.fase === "concluido" ? (
            <p className="text-floresta-texto">
              Histórico completo{progresso.total !== null ? ` (${progresso.total.toLocaleString("pt-BR")} mensagens)` : ""}
              {progresso.concluidoEm
                ? `, baixado em ${new Date(progresso.concluidoEm).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}`
                : ""}
              .
            </p>
          ) : (
            <>
              <p className="text-muted">
                {progresso.fase === "erro" ? (progresso.erro ?? "Falhou; tentando de novo.") : "Baixando…"} {pct !== null ? `${pct}%` : ""}
                {progresso.total !== null ? ` de ${progresso.total.toLocaleString("pt-BR")} mensagens` : ""}
              </p>
              {pct !== null && (
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-superficie-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-floresta" style={{ width: `${pct}%` }} />
                </div>
              )}
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => sincronizarHistorico(personId, numero.id, reler, { recomecar: true })} className={botaoSecundario}>
              Baixar de novo
            </button>
            <button
              type="button"
              onClick={() => {
                void apagarHistoricoDoAparelho(personId);
              }}
              className={botaoSecundario}
            >
              Apagar deste aparelho
            </button>
          </div>
        </section>
        <section className="rounded-md border border-linha p-3 text-sm">
          <p className="font-medium">Faltou histórico?</p>
          <p className="text-muted">
            O celular só manda o histórico no pareamento. Para pedir de novo, desconecte e leia o QR code; espere alguns minutos e use "Baixar de
            novo".
          </p>
          <button type="button" disabled={preparar.isPending} onClick={() => preparar.mutate()} className={`${botaoSecundario} mt-2`}>
            Desconectar e mostrar o QR code
          </button>
        </section>
        <div className="flex justify-end">
          <button type="button" onClick={fechar} className={botaoSecundario}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
