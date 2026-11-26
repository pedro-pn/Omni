import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Check,
  Folder,
  FolderPlus,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  apagarPasta,
  criarPasta,
  organizacao,
  organizarItem,
  renomearPasta,
  type Organizacao,
  type TipoOrganizado,
} from "../../lib/organizacao-fns.ts";

/**
 * Abas pessoais das listas de Missões e Conversas (0059): Todas, as pastas da pessoa
 * e Arquivadas; cada item tem o menu ⋮ para mover de pasta e arquivar. Só para ela.
 */

export type AbaOrganizacao = "todas" | "arquivadas" | string;

const chave = (tipo: TipoOrganizado) => ["organizacao", tipo] as const;

export function useOrganizacao(tipo: TipoOrganizado) {
  return useQuery({
    queryKey: chave(tipo),
    queryFn: () => organizacao({ data: { tipo } }),
    staleTime: 60_000,
  });
}

/** Lembra a aba escolhida neste aparelho (se o navegador deixar). */
export function useAbaOrganizacao(
  tipo: TipoOrganizado,
): [AbaOrganizacao, (a: AbaOrganizacao) => void] {
  const [aba, setAba] = useState<AbaOrganizacao>("todas");
  useEffect(() => {
    try {
      const salva = localStorage.getItem(`omni-aba-${tipo}`);
      if (salva) setAba(salva);
    } catch {
      /* sem armazenamento: começa em Todas */
    }
  }, [tipo]);
  return [
    aba,
    (a) => {
      setAba(a);
      try {
        localStorage.setItem(`omni-aba-${tipo}`, a);
      } catch {
        /* ignora */
      }
    },
  ];
}

/** Itens da aba: Todas (não arquivados), uma pasta (não arquivados) ou Arquivadas. */
export function filtrarPorAba<T>(
  itens: T[],
  id: (t: T) => string,
  org: Organizacao | undefined,
  aba: AbaOrganizacao,
): T[] {
  const de = (t: T) => org?.itens[id(t)];
  if (aba === "arquivadas") return itens.filter((t) => de(t)?.arquivado);
  if (aba === "todas") return itens.filter((t) => !de(t)?.arquivado);
  return itens.filter((t) => !de(t)?.arquivado && de(t)?.pastaId === aba);
}

export function AbasOrganizacao({
  tipo,
  aba,
  onAba,
  semArquivadas = false,
}: {
  tipo: TipoOrganizado;
  aba: AbaOrganizacao;
  onAba: (a: AbaOrganizacao) => void;
  /** Conversas: as arquivadas ficam na linha "Arquivadas" do topo da lista, como no WhatsApp. */
  semArquivadas?: boolean;
}) {
  const qc = useQueryClient();
  const org = useOrganizacao(tipo);
  const [nova, setNova] = useState(false);
  const atualizar = () => void qc.invalidateQueries({ queryKey: chave(tipo) });
  const criar = useMutation({
    mutationFn: (nome: string) => criarPasta({ data: { tipo, nome } }),
    onSuccess: async (r) => {
      setNova(false);
      // Abre a pasta nova depois de a lista de pastas já trazê-la.
      await qc.invalidateQueries({ queryKey: chave(tipo) });
      onAba(r.id);
    },
  });
  const pastas = org.data?.pastas ?? [];
  // Pasta apagada em outro aparelho: volta para Todas.
  useEffect(() => {
    if (
      org.data &&
      !org.isFetching &&
      aba !== "todas" &&
      aba !== "arquivadas" &&
      !pastas.some((p) => p.id === aba)
    )
      onAba("todas");
  }, [org.data, org.isFetching, aba, pastas, onAba]);
  const abaClasse = (ativa: boolean) =>
    `shrink-0 rounded-full px-3 py-1 text-sm ${ativa ? "bg-floresta text-white" : "bg-superficie-2 text-muted hover:text-ink"}`;
  return (
    <div className="border-b border-linha">
      <div className="flex items-center gap-1 pr-2">
        <div
          role="tablist"
          aria-label={
            tipo === "missao" ? "Pastas das missões" : "Pastas das conversas"
          }
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-2 pl-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            role="tab"
            aria-selected={aba === "todas"}
            onClick={() => onAba("todas")}
            className={abaClasse(aba === "todas")}
          >
            Todas
          </button>
          {pastas.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={aba === p.id}
              onClick={() => onAba(p.id)}
              className={`${abaClasse(aba === p.id)} flex items-center gap-1`}
            >
              <Folder size={13} aria-hidden /> {p.nome}
            </button>
          ))}
          {!semArquivadas && (
            <button
              type="button"
              role="tab"
              aria-selected={aba === "arquivadas"}
              onClick={() => onAba("arquivadas")}
              className={`${abaClasse(aba === "arquivadas")} flex items-center gap-1`}
            >
              <Archive size={13} aria-hidden /> Arquivadas
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setNova(true)}
          aria-label="Nova pasta"
          title="Nova pasta"
          className="shrink-0 rounded-full p-1.5 text-muted hover:bg-superficie-2 hover:text-ink"
        >
          <FolderPlus size={16} aria-hidden />
        </button>
      </div>
      {nova && (
        <form
          className="flex items-center gap-2 px-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            criar.mutate(
              String(new FormData(e.currentTarget).get("nome") ?? ""),
            );
          }}
        >
          <input
            name="nome"
            autoFocus
            maxLength={60}
            placeholder="Nome da pasta"
            aria-label="Nome da pasta"
            className="min-w-0 flex-1 rounded-md border border-linha bg-superficie px-2 py-1 text-sm"
            onKeyDown={(e) => e.key === "Escape" && setNova(false)}
          />
          <button
            type="submit"
            disabled={criar.isPending}
            className="rounded-md bg-floresta px-3 py-1 text-sm text-white"
          >
            Criar
          </button>
          <button
            type="button"
            onClick={() => setNova(false)}
            className="text-sm text-muted"
          >
            Cancelar
          </button>
        </form>
      )}
      {criar.isError && (
        <p className="px-4 pb-2 text-xs text-vermelho">
          {criar.error instanceof Error
            ? criar.error.message
            : "Não foi possível criar."}
        </p>
      )}
      {aba !== "todas" && aba !== "arquivadas" && (
        <EditarPasta
          tipo={tipo}
          pasta={pastas.find((p) => p.id === aba)}
          onApagada={() => onAba("todas")}
        />
      )}
    </div>
  );
}

function EditarPasta({
  tipo,
  pasta,
  onApagada,
}: {
  tipo: TipoOrganizado;
  pasta: { id: string; nome: string } | undefined;
  onApagada: () => void;
}) {
  const qc = useQueryClient();
  const [renomeando, setRenomeando] = useState(false);
  const atualizar = () => void qc.invalidateQueries({ queryKey: chave(tipo) });
  const renomear = useMutation({
    mutationFn: (nome: string) =>
      renomearPasta({ data: { id: pasta!.id, nome } }),
    onSuccess: () => (setRenomeando(false), atualizar()),
  });
  const apagar = useMutation({
    mutationFn: () => apagarPasta({ data: { id: pasta!.id } }),
    onSuccess: () => (atualizar(), onApagada()),
  });
  if (!pasta) return null;
  if (renomeando)
    return (
      <form
        className="flex items-center gap-2 px-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          renomear.mutate(
            String(new FormData(e.currentTarget).get("nome") ?? ""),
          );
        }}
      >
        <input
          name="nome"
          autoFocus
          defaultValue={pasta.nome}
          maxLength={60}
          aria-label="Novo nome da pasta"
          className="min-w-0 flex-1 rounded-md border border-linha bg-superficie px-2 py-1 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-floresta px-3 py-1 text-sm text-white"
        >
          Salvar
        </button>
        <button
          type="button"
          onClick={() => setRenomeando(false)}
          className="text-sm text-muted"
        >
          Cancelar
        </button>
      </form>
    );
  return (
    <div className="flex gap-3 px-4 pb-2 text-xs text-muted">
      <button
        type="button"
        onClick={() => setRenomeando(true)}
        className="flex items-center gap-1 hover:text-ink"
      >
        <Pencil size={12} aria-hidden /> Renomear pasta
      </button>
      <button
        type="button"
        onClick={() =>
          confirm(
            `Apagar a pasta "${pasta.nome}"? O que está nela volta para Todas.`,
          ) && apagar.mutate()
        }
        className="flex items-center gap-1 hover:text-vermelho"
      >
        <Trash2 size={12} aria-hidden /> Apagar pasta
      </button>
    </div>
  );
}

/** Menu ⋮ do item: mover para uma pasta (ou tirar da pasta) e arquivar/desarquivar. */
export function MenuOrganizar({
  tipo,
  itemId,
  nome,
  rotulos = { arquivar: "Arquivar", desarquivar: "Desarquivar" },
}: {
  tipo: TipoOrganizado;
  itemId: string;
  nome: string;
  /** Conversas: o arquivo permanente é "Manter arquivada" (o Arquivar delas volta com mensagem nova). */
  rotulos?: { arquivar: string; desarquivar: string };
}) {
  const qc = useQueryClient();
  const org = useOrganizacao(tipo);
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const atual = org.data?.itens[itemId];
  const mudar = useMutation({
    mutationFn: (v: { pastaId?: string | null; arquivar?: boolean }) =>
      organizarItem({ data: { tipo, itemId, ...v } }),
    onMutate: async (v) => {
      // Muda na hora; o servidor confirma.
      setAberto(false);
      await qc.cancelQueries({ queryKey: chave(tipo) });
      qc.setQueryData<Organizacao>(chave(tipo), (o) =>
        o
          ? {
              ...o,
              itens: {
                ...o.itens,
                [itemId]: {
                  pastaId:
                    v.pastaId !== undefined
                      ? v.pastaId
                      : (o.itens[itemId]?.pastaId ?? null),
                  arquivado: v.arquivar ?? o.itens[itemId]?.arquivado ?? false,
                },
              },
            }
          : o,
      );
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: chave(tipo) }),
  });
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) =>
      !ref.current?.contains(e.target as Node) && setAberto(false);
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);
  return (
    <div
      ref={ref}
      className="relative shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setAberto(!aberto)}
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-label={`Organizar ${nome}`}
        className="rounded-md p-1 text-muted hover:bg-superficie-2 hover:text-ink"
      >
        <MoreVertical size={16} aria-hidden />
      </button>
      {aberto && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-30 w-56 rounded-md border border-linha bg-superficie py-1 text-sm shadow-lg"
        >
          <p className="rotulo px-3 py-1 text-muted">Mover para</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => mudar.mutate({ pastaId: null })}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-superficie-2"
          >
            Sem pasta {!atual?.pastaId && <Check size={14} aria-hidden />}
          </button>
          {(org.data?.pastas ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              onClick={() => mudar.mutate({ pastaId: p.id })}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-superficie-2"
            >
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <Folder size={13} aria-hidden /> {p.nome}
              </span>
              {atual?.pastaId === p.id && <Check size={14} aria-hidden />}
            </button>
          ))}
          {!(org.data?.pastas ?? []).length && (
            <p className="px-3 py-1 text-xs text-muted">
              Crie pastas no ícone de pasta acima da lista.
            </p>
          )}
          <div className="my-1 border-t border-linha" />
          <button
            type="button"
            role="menuitem"
            onClick={() => mudar.mutate({ arquivar: !atual?.arquivado })}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-superficie-2"
          >
            {atual?.arquivado ? (
              <ArchiveRestore size={14} aria-hidden />
            ) : (
              <Archive size={14} aria-hidden />
            )}{" "}
            {atual?.arquivado ? rotulos.desarquivar : rotulos.arquivar}
          </button>
        </div>
      )}
    </div>
  );
}
