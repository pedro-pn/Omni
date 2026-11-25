import { useSyncExternalStore } from "react";

import { paginaDoHistorico, type MensagemDoAparelho } from "./whatsapp-aparelho-fns.ts";

/**
 * Histórico do WhatsApp guardado NESTE aparelho (IndexedDB), como o WhatsApp Web.
 *
 * - Um banco por pessoa (`omni-whatsapp-<pessoa>`): no mesmo computador, cada
 *   pessoa só abre o seu. Sair do Omni apaga tudo (apagarHistoricoDoAparelho).
 * - A sincronização baixa o histórico da Evolution em páginas de 200, das mais
 *   novas para as mais antigas, e continua de onde parou (página salva). As
 *   mensagens novas que chegam durante a cópia empurram as antigas para páginas
 *   seguintes: nada se perde, no máximo repete (a chave não duplica).
 * - Uma aba por vez (Web Locks); o servidor não guarda as mensagens antigas.
 */

const PREFIXO = "omni-whatsapp-";

/** Pessoa da sessão neste aparelho (o shell define ao abrir). */
let pessoa: string | null = null;
export function definirPessoaDoAparelho(personId: string) {
  pessoa = personId;
}
export const pessoaDoAparelho = () => pessoa;
const VERSAO = 1;

type Estado = { numberId: string; proxima: number; paginas: number | null; total: number | null; concluidoEm: string | null; comecouEm: string };

function abrir(personId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(`${PREFIXO}${personId}`, VERSAO);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("mensagens")) {
        const s = db.createObjectStore("mensagens", { keyPath: "chave" });
        s.createIndex("conversa", ["chatId", "em"]);
      }
      if (!db.objectStoreNames.contains("sincronizacao")) db.createObjectStore("sincronizacao", { keyPath: "numberId" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("bloqueado"));
  });
}

const conexoes = new Map<string, Promise<IDBDatabase>>();
function banco(personId: string) {
  let c = conexoes.get(personId);
  if (!c) {
    c = abrir(personId);
    conexoes.set(personId, c);
    c.then((db) => {
      db.onversionchange = () => {
        db.close();
        conexoes.delete(personId);
      };
    }).catch(() => conexoes.delete(personId));
  }
  return c;
}

const pedido = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));
const fim = (t: IDBTransaction) => new Promise<void>((resolve, reject) => ((t.oncomplete = () => resolve()), (t.onerror = () => reject(t.error)), (t.onabort = () => reject(t.error))));

async function guardar(personId: string, lista: MensagemDoAparelho[], estado: Estado) {
  const db = await banco(personId);
  const t = db.transaction(["mensagens", "sincronizacao"], "readwrite");
  const s = t.objectStore("mensagens");
  for (const m of lista) s.put({ ...m, chave: `${m.chatId}|${m.waId}` });
  t.objectStore("sincronizacao").put(estado);
  await fim(t);
}

async function lerEstado(personId: string, numberId: string): Promise<Estado | undefined> {
  const db = await banco(personId);
  return pedido(db.transaction("sincronizacao").objectStore("sincronizacao").get(numberId)) as Promise<Estado | undefined>;
}

/** As `limite` mensagens mais recentes de uma conversa guardadas no aparelho, em ordem de envio. */
export async function mensagensDoAparelho(personId: string, chatId: string, limite: number): Promise<{ mensagens: MensagemDoAparelho[]; haMais: boolean }> {
  if (typeof indexedDB === "undefined") return { mensagens: [], haMais: false };
  const db = await banco(personId);
  const indice = db.transaction("mensagens").objectStore("mensagens").index("conversa");
  const faixa = IDBKeyRange.bound([chatId, ""], [chatId, "￿"]);
  const lista: MensagemDoAparelho[] = [];
  return new Promise((resolve, reject) => {
    const c = indice.openCursor(faixa, "prev");
    c.onerror = () => reject(c.error);
    c.onsuccess = () => {
      const cursor = c.result;
      if (!cursor) return resolve({ mensagens: lista.reverse(), haMais: false });
      if (lista.length === limite) return resolve({ mensagens: lista.reverse(), haMais: true });
      lista.push(cursor.value as MensagemDoAparelho);
      cursor.continue();
    };
  });
}

/** Apaga o histórico guardado neste aparelho (de todas as pessoas, ao sair; ou só de uma). */
export async function apagarHistoricoDoAparelho(personId?: string) {
  if (typeof indexedDB === "undefined") return;
  pararSincronizacao();
  const nomes = personId
    ? [`${PREFIXO}${personId}`]
    : ((await indexedDB.databases?.().catch(() => [])) ?? []).map((d) => d.name ?? "").filter((n) => n.startsWith(PREFIXO));
  for (const nome of nomes) {
    const id = nome.slice(PREFIXO.length);
    const c = conexoes.get(id);
    conexoes.delete(id);
    await c?.then((db) => db.close()).catch(() => {});
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(nome);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }
  publicar({ ...INICIAL });
}

// ---------------------------------------------------------------- progresso (para a tela)

export type Progresso = {
  fase: "parado" | "baixando" | "concluido" | "erro" | "outraAba";
  numberId: string | null;
  pagina: number;
  paginas: number | null;
  total: number | null;
  concluidoEm: string | null;
  erro: string | null;
  /** Conta as páginas gravadas: a conversa aberta relê o aparelho quando muda e a página tocou nela. */
  versao: number;
  tocadas: ReadonlySet<string>;
};
const INICIAL: Progresso = { fase: "parado", numberId: null, pagina: 0, paginas: null, total: null, concluidoEm: null, erro: null, versao: 0, tocadas: new Set() };
let progresso: Progresso = INICIAL;
const ouvintes = new Set<() => void>();
function publicar(p: Progresso) {
  progresso = p;
  for (const f of ouvintes) f();
}
export function useProgressoDoHistorico(): Progresso {
  return useSyncExternalStore(
    (f) => (ouvintes.add(f), () => ouvintes.delete(f)),
    () => progresso,
    () => INICIAL,
  );
}

// ---------------------------------------------------------------- sincronização

let ativa: { personId: string; numberId: string; parar: AbortController } | null = null;

export function pararSincronizacao() {
  ativa?.parar.abort();
  ativa = null;
}

const esperar = (ms: number, sinal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    sinal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Baixa o histórico do número para este aparelho (continua de onde parou).
 * `aoAvancar` é chamado a cada 10 páginas e no fim (a lista de conversas relê o servidor).
 */
export function sincronizarHistorico(personId: string, numberId: string, aoAvancar: () => void, opcoes: { recomecar?: boolean } = {}) {
  if (typeof indexedDB === "undefined") return;
  if (ativa && ativa.personId === personId && ativa.numberId === numberId && !opcoes.recomecar) return;
  pararSincronizacao();
  const parar = new AbortController();
  ativa = { personId, numberId, parar };
  const rodar = async () => {
    void navigator.storage?.persist?.().catch(() => false);
    let estado: Estado | undefined = opcoes.recomecar ? undefined : await lerEstado(personId, numberId).catch(() => undefined);
    estado ??= { numberId, proxima: 1, paginas: null, total: null, concluidoEm: null, comecouEm: new Date().toISOString() };
    const base = { numberId, paginas: estado.paginas, total: estado.total, concluidoEm: estado.concluidoEm, erro: null };
    // Já completo: confere a página seguinte (o celular manda o histórico aos poucos
    // depois do pareamento, e as mensagens novas empurram as antigas para o fim).
    publicar({ ...progresso, ...base, fase: estado.concluidoEm ? "concluido" : "baixando", pagina: estado.proxima - 1 });
    let falhas = 0;
    while (!parar.signal.aborted) {
      try {
        const r: { mensagens: MensagemDoAparelho[]; paginas: number; total: number } = await paginaDoHistorico({ data: { numberId, pagina: estado.proxima } });
        if (parar.signal.aborted) return;
        // Página além do fim: nada novo; não avança (a próxima abertura confere de novo).
        const alem: boolean = estado.proxima > r.paginas;
        const fimDoHistorico: boolean = alem || estado.proxima >= r.paginas;
        estado = {
          ...estado,
          proxima: alem ? estado.proxima : estado.proxima + 1,
          paginas: r.paginas,
          total: r.total,
          concluidoEm: fimDoHistorico ? (estado.concluidoEm ?? new Date().toISOString()) : null,
        };
        await guardar(personId, alem ? [] : r.mensagens, estado);
        falhas = 0;
        publicar({
          ...progresso,
          fase: fimDoHistorico ? "concluido" : "baixando",
          numberId,
          pagina: estado.proxima - 1,
          paginas: r.paginas,
          total: r.total,
          concluidoEm: estado.concluidoEm,
          erro: null,
          versao: progresso.versao + 1,
          tocadas: new Set(r.mensagens.map((m) => m.chatId)),
        });
        if (fimDoHistorico || (estado.proxima - 1) % 10 === 0) aoAvancar();
        if (fimDoHistorico) return;
      } catch (e) {
        falhas += 1;
        publicar({ ...progresso, fase: "erro", erro: e instanceof Error && e.message ? e.message : "Não foi possível baixar o histórico agora." });
        // Tenta de novo enquanto o Omni estiver aberto: 15 s, 30 s, … até 5 min.
        await esperar(Math.min(15_000 * 2 ** (falhas - 1), 300_000), parar.signal);
        if (!parar.signal.aborted) publicar({ ...progresso, fase: "baixando", erro: null });
      }
    }
  };
  const travar = navigator.locks?.request.bind(navigator.locks);
  const executar = () =>
    rodar()
      .catch(() => publicar({ ...progresso, fase: "erro", erro: "Não foi possível guardar o histórico neste aparelho." }))
      .finally(() => {
        if (ativa?.parar === parar) ativa = null;
      });
  if (!travar) return void executar();
  // Outra aba já está baixando: esta só mostra.
  void travar(`omni-historico-${personId}-${numberId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      publicar({ ...progresso, fase: "outraAba", numberId });
      if (ativa?.parar === parar) ativa = null;
      return;
    }
    await executar();
  });
}
