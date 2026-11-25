import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Download, Smartphone, X } from "lucide-react";
import { useEffect, useState } from "react";

import { criarAgenda, desativarAgenda, statusAgenda } from "../../lib/agenda-fns.ts";
import { configPush, desinscreverAparelho, inscreverAparelho, preferenciasEmail, salvarPreferenciasEmail, salvarPreferenciasPush, testarNotificacao, type PreferenciasEmail } from "../../lib/push-fns.ts";

/**
 * App instalável (PWA) e notificações no aparelho (Web Push). O service worker
 * (/sw.js) só mostra notificações; não guarda dados em cache.
 */

type EventoInstalar = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let pedidoDeInstalacao: EventoInstalar | null = null;
const ouvintesInstalacao = new Set<() => void>();

/** Registra o service worker e guarda o convite de instalação do navegador (chamar uma vez, no AppShell). */
export function iniciarAppInstalavel(reinscrever: () => void): () => void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return () => {};
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  const aoConvite = (e: Event) => {
    e.preventDefault();
    pedidoDeInstalacao = e as EventoInstalar;
    ouvintesInstalacao.forEach((f) => f());
  };
  const aoMensagem = (e: MessageEvent) => {
    if (e.data?.tipo === "reinscrever") reinscrever();
  };
  window.addEventListener("beforeinstallprompt", aoConvite);
  navigator.serviceWorker.addEventListener("message", aoMensagem);
  return () => {
    window.removeEventListener("beforeinstallprompt", aoConvite);
    navigator.serviceWorker.removeEventListener("message", aoMensagem);
  };
}

const base64ParaBytes = (b64: string) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const suportaPush = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const instalado = () => typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
const ehIphone = () => typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);

/** Inscreve este aparelho (pede a permissão se preciso). */
export async function inscreverEsteAparelho(chavePublica: string): Promise<void> {
  const permissao = await Notification.requestPermission();
  if (permissao !== "granted") throw new Error("O navegador não deu permissão. Libere as notificações do Omni nas configurações do navegador.");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ParaBytes(chavePublica) }));
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await inscreverAparelho({ data: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth } });
}

/** Ao sair do Omni: este aparelho para de receber as notificações de quem saiu. */
export async function desinscreverEsteAparelho(): Promise<void> {
  if (!suportaPush()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await desinscreverAparelho({ data: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export function NotificacoesApp({ fechar }: { fechar: () => void }) {
  const qc = useQueryClient();
  const [, atualizar] = useState(0);
  const [inscrito, setInscrito] = useState<boolean | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const config = useQuery({ queryKey: ["push"], queryFn: () => configPush() });

  useEffect(() => {
    const f = () => atualizar((n) => n + 1);
    ouvintesInstalacao.add(f);
    if (suportaPush()) {
      void navigator.serviceWorker.getRegistration().then(async (r) => setInscrito(Boolean(await r?.pushManager.getSubscription())));
    } else setInscrito(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("keydown", esc);
    return () => {
      ouvintesInstalacao.delete(f);
      window.removeEventListener("keydown", esc);
    };
  }, [fechar]);

  const ativar = useMutation({
    mutationFn: async () => {
      if (!config.data?.chavePublica) throw new Error("As notificações ainda não foram configuradas neste ambiente.");
      await inscreverEsteAparelho(config.data.chavePublica);
    },
    onMutate: () => setAviso(null),
    onSuccess: () => {
      setInscrito(true);
      setAviso("Notificações ativadas neste aparelho.");
      void qc.invalidateQueries({ queryKey: ["push"] });
    },
  });
  const desativar = useMutation({
    mutationFn: desinscreverEsteAparelho,
    onSuccess: () => {
      setInscrito(false);
      setAviso("Este aparelho não recebe mais notificações do Omni.");
      void qc.invalidateQueries({ queryKey: ["push"] });
    },
  });
  const prefs = useMutation({
    mutationFn: (v: { canais: boolean; whatsapp: boolean; email: boolean }) => salvarPreferenciasPush({ data: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["push"] }),
  });
  const teste = useMutation({ mutationFn: () => testarNotificacao(), onSuccess: () => setAviso("Teste enviado. Deve chegar em alguns segundos.") });
  const erro = [ativar.error, desativar.error, prefs.error, teste.error].find(Boolean) as Error | undefined;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="titulo-notificacoes" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 text-ink">
      <div className="max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg bg-superficie p-5 shadow-xl">
        <header className="flex items-center justify-between">
          <h2 id="titulo-notificacoes" className="text-lg font-semibold">
            Notificações e app
          </h2>
          <button type="button" onClick={fechar} aria-label="Fechar" className="rounded-md p-1 hover:bg-superficie-2">
            <X size={18} />
          </button>
        </header>

        <section className="space-y-2 text-sm">
          <h3 className="flex items-center gap-2 font-medium">
            <Smartphone size={16} aria-hidden /> Instalar o Omni
          </h3>
          {instalado() ? (
            <p className="text-muted">O Omni já está instalado neste aparelho.</p>
          ) : pedidoDeInstalacao ? (
            <button
              type="button"
              onClick={async () => {
                await pedidoDeInstalacao?.prompt();
                pedidoDeInstalacao = null;
                atualizar((n) => n + 1);
              }}
              className="flex items-center gap-2 rounded-md bg-floresta px-3 py-1.5 font-medium text-white"
            >
              <Download size={16} aria-hidden /> Instalar o Omni
            </button>
          ) : ehIphone() ? (
            <p className="text-muted">
              No iPhone: toque em <b>Compartilhar</b> (o quadrado com a seta) e depois em <b>Adicionar à Tela de Início</b>. As notificações no iPhone só
              funcionam com o Omni instalado assim.
            </p>
          ) : (
            <p className="text-muted">Use o menu do navegador: "Instalar app" ou "Adicionar à tela inicial".</p>
          )}
        </section>

        <section className="space-y-2 text-sm">
          <h3 className="flex items-center gap-2 font-medium">
            <BellRing size={16} aria-hidden /> Notificações neste aparelho
          </h3>
          {!suportaPush() ? (
            <p className="text-muted">{ehIphone() ? "Instale o Omni na Tela de Início e abra por lá para ativar as notificações." : "Este navegador não recebe notificações."}</p>
          ) : !config.data?.chavePublica && config.isSuccess ? (
            <p className="text-muted">As notificações ainda não foram configuradas neste ambiente.</p>
          ) : inscrito ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={teste.isPending} onClick={() => teste.mutate()} className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie-2">
                Enviar notificação de teste
              </button>
              <button type="button" disabled={desativar.isPending} onClick={() => desativar.mutate()} className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie-2">
                Desativar neste aparelho
              </button>
            </div>
          ) : (
            <button type="button" disabled={ativar.isPending || inscrito === null || !config.data} onClick={() => ativar.mutate()} className="rounded-md bg-floresta px-3 py-1.5 font-medium text-white">
              Ativar notificações neste aparelho
            </button>
          )}
          {config.data && (
            <fieldset className="space-y-1 pt-1">
              <legend className="text-muted">Além dos avisos do sino (tarefas, alertas e perguntas da IA), receber:</legend>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.data.canais} onChange={(e) => prefs.mutate({ canais: e.target.checked, whatsapp: config.data!.whatsapp, email: config.data!.email })} />
                Mensagens dos canais Interno e Gerencial que acompanho
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.data.whatsapp} onChange={(e) => prefs.mutate({ canais: config.data!.canais, whatsapp: e.target.checked, email: config.data!.email })} />
                Mensagens do WhatsApp dos números que acompanho
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.data.email} onChange={(e) => prefs.mutate({ canais: config.data!.canais, whatsapp: config.data!.whatsapp, email: e.target.checked })} />
                E-mails novos na minha caixa
              </label>
              <p className="text-xs text-muted">
                Valem para todos os seus aparelhos ({config.data.aparelhos} com notificação ativa). Ao sair do Omni, este aparelho deixa de receber.
              </p>
            </fieldset>
          )}
          {aviso && <p className="text-floresta-texto">{aviso}</p>}
          {erro && <p className="text-vermelho">{erro.message}</p>}
        </section>
        <PreferenciasDeEmail />
        <AgendaPorLink />
      </div>
    </div>
  );
}

const ROTULOS_EMAIL: Array<[keyof PreferenciasEmail, string]> = [
  ["atribuicoes", "Tarefas que passarem para mim"],
  ["mencoes", "Quando me marcarem com @"],
  ["comentarios", "Comentários e reações nas minhas tarefas"],
  ["lembretes", "Lembretes das tarefas"],
  ["concluidas", "Tarefas concluídas por outras pessoas"],
  ["resumoSemanal", "Resumo semanal às segundas (atrasadas às 9h, da semana às 14h)"],
];

/** E-mail (como no Foco): avisos não lidos reunidos num e-mail e o resumo semanal. */
function PreferenciasDeEmail() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["email", "preferencias"], queryFn: () => preferenciasEmail() });
  const salvar = useMutation({
    mutationFn: (v: PreferenciasEmail) => salvarPreferenciasEmail({ data: v }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["email", "preferencias"] }),
  });
  if (!q.data) return null;
  const { modo, ...atual } = q.data;
  return (
    <section aria-labelledby="titulo-email" className="space-y-2 border-t border-linha pt-4 text-sm">
      <h3 id="titulo-email" className="font-semibold">
        Por e-mail
      </h3>
      <p className="text-muted">Avisos que você ainda não viu no Omni chegam reunidos num e-mail só, poucos minutos depois.</p>
      {modo !== "real" && (
        <p className="rounded-md bg-superficie-2 px-3 py-2 text-xs text-muted">
          {modo === "desligado" ? "O envio de e-mails está desligado neste ambiente." : "Neste ambiente os e-mails são montados e registrados, mas não saem (ensaio)."}
        </p>
      )}
      <fieldset className="space-y-1">
        <legend className="sr-only">O que receber por e-mail</legend>
        {ROTULOS_EMAIL.map(([chave, rotulo]) => (
          <label key={chave} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={atual[chave]}
              disabled={salvar.isPending}
              onChange={(e) => {
                const valor = e.target.checked;
                salvar.mutate({ ...atual, [chave]: valor });
              }}
            />
            {rotulo}
          </label>
        ))}
      </fieldset>
      {salvar.isError && <p className="text-vermelho">Não foi possível salvar. Tente de novo.</p>}
    </section>
  );
}

/** Link privado da agenda das tarefas (.ics): iPhone, Mac, Google Agenda e Outlook por assinatura. */
function AgendaPorLink() {
  const qc = useQueryClient();
  const [copiado, setCopiado] = useState(false);
  const q = useQuery({ queryKey: ["agenda"], queryFn: () => statusAgenda() });
  const atualizar = () => void qc.invalidateQueries({ queryKey: ["agenda"] });
  const criar = useMutation({ mutationFn: (trocar: boolean) => criarAgenda({ data: { trocar } }), onSuccess: atualizar });
  const desativar = useMutation({ mutationFn: () => desativarAgenda(), onSuccess: atualizar });
  if (!q.data?.configurada) return null;
  const a = q.data;
  const ocupado = criar.isPending || desativar.isPending;
  return (
    <section aria-labelledby="titulo-agenda" className="space-y-2 border-t border-linha pt-4 text-sm">
      <h3 id="titulo-agenda" className="font-semibold">
        Agenda no celular
      </h3>
      <p className="text-muted">
        Suas tarefas abertas com data aparecem no Calendário do iPhone ou do Mac, e também no Google Agenda ou no Outlook pela opção de assinar uma agenda por URL. Atualiza sozinha.
      </p>
      {a.ativa && a.webcal && a.https ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <a href={a.webcal} className="rounded-md bg-floresta px-3 py-1.5 font-medium text-white">
              Abrir no Calendário
            </a>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(a.https!).then(() => setCopiado(true));
              }}
              className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie-2"
            >
              {copiado ? "Link copiado" : "Copiar link"}
            </button>
          </div>
          <p className="text-xs text-muted">
            Quem tiver este link vê suas tarefas. Não compartilhe.{" "}
            {a.ultimoAcesso ? `Último acesso: ${new Date(a.ultimoAcesso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}.` : "Ainda não foi aberto."}
          </p>
          <div className="flex flex-wrap gap-3 text-xs">
            <button type="button" disabled={ocupado} onClick={() => confirm("Trocar o link? O atual para de funcionar e será preciso assinar de novo.") && criar.mutate(true)} className="text-floresta-texto underline">
              Trocar link
            </button>
            <button type="button" disabled={ocupado} onClick={() => confirm("Desativar a agenda por link? As agendas que assinaram param de atualizar.") && desativar.mutate()} className="text-vermelho underline">
              Desativar
            </button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={ocupado} onClick={() => criar.mutate(false)} className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie-2">
          Criar link da agenda
        </button>
      )}
      {(criar.isError || desativar.isError) && <p className="text-vermelho">Não foi possível agora. Tente de novo.</p>}
    </section>
  );
}
