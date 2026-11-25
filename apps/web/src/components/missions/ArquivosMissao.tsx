import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, ExternalLink, FileText, Folder, FolderOpen, Info } from "lucide-react";
import { useState } from "react";

import { abrirPasta, listarArquivosDaMissao, type PastaVinculada } from "../../lib/arquivos-fns.ts";
import { FalhaAoCarregar } from "../comum/TentarDeNovo.tsx";

/**
 * Aba Arquivos da missão (protótipo: `filesPanelHTML`): as pastas comerciais
 * do SharePoint que o Prisma vincula à missão e ao cliente. O Omni não cria
 * nem reorganiza pastas; abre pelo servidor, com a permissão de cada pessoa.
 */

const tamanho = (b: number | null) =>
  b === null ? "" : b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" }) : "";
const extensao = (nome: string) => (nome.includes(".") ? nome.split(".").pop()!.slice(0, 4).toUpperCase() : "");
const mensagem = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível abrir a pasta agora.");

function ListaPastas({ titulo, pastas, onAbrir }: { titulo: string; pastas: PastaVinculada[]; onAbrir: (p: PastaVinculada) => void }) {
  return (
    <section className="rounded-lg border border-linha bg-superficie p-4">
      <h3 className="rotulo text-muted">{titulo}</h3>
      <ul className="mt-2 divide-y divide-linha">
        {pastas.map((p) => {
          const pronta = p.status === "ready";
          return (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <button
                type="button"
                disabled={!pronta}
                onClick={() => onAbrir(p)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-superficie-2 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <Folder size={18} className={pronta ? "text-floresta-texto" : "text-muted"} aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.rotulo}</span>
                  <span className="block text-xs text-muted">
                    {p.origem === "mission" ? "Pasta da missão" : "Pasta da oportunidade"}
                    {!pronta && " · biblioteca do SharePoint ainda não configurada no Prisma"}
                  </span>
                </span>
              </button>
              {p.webUrl && (
                <a href={p.webUrl} target="_blank" rel="noopener noreferrer" className="flex shrink-0 items-center gap-1 text-xs text-floresta-texto hover:underline">
                  <ExternalLink size={14} aria-hidden /> Abrir no SharePoint
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Navegador({ pasta, onVoltar }: { pasta: PastaVinculada; onVoltar: () => void }) {
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const q = useQuery({
    queryKey: ["pasta", pasta.id, itemId ?? "raiz"],
    queryFn: () => abrirPasta({ data: { pastaId: pasta.id, itemId } }),
    retry: false,
  });
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-5">
      <button type="button" onClick={onVoltar} className="flex items-center gap-1 text-sm text-floresta-texto hover:underline">
        <ArrowLeft size={16} aria-hidden /> Todas as pastas
      </button>
      <nav aria-label="Caminho da pasta" className="flex flex-wrap items-center gap-1 text-sm">
        <FolderOpen size={16} className="text-floresta-texto" aria-hidden />
        {(q.data?.caminho ?? [{ id: "", nome: pasta.rotulo }]).map((c, i, todos) => (
          <span key={c.id || i} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted">/</span>}
            {i < todos.length - 1 ? (
              <button type="button" onClick={() => setItemId(i === 0 ? undefined : c.id)} className="hover:underline">
                {c.nome}
              </button>
            ) : (
              <b aria-current="location">{c.nome}</b>
            )}
          </span>
        ))}
      </nav>
      {q.isPending ? (
        <p className="text-sm text-muted">Abrindo a pasta…</p>
      ) : q.isError ? (
        <p className="rounded-md bg-superficie-2 p-3 text-sm">{mensagem(q.error)}</p>
      ) : q.data.itens.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Pasta vazia.</p>
      ) : (
        <ul className="divide-y divide-linha rounded-lg border border-linha bg-superficie">
          {q.data.itens.map((i) =>
            i.tipo === "pasta" ? (
              <li key={i.id}>
                <button type="button" onClick={() => setItemId(i.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-superficie-2">
                  <Folder size={18} className="text-floresta-texto" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{i.nome}</span>
                    <span className="block text-xs text-muted">{i.filhos === null ? "Pasta" : `${i.filhos} ${i.filhos === 1 ? "item" : "itens"}`}</span>
                  </span>
                </button>
              </li>
            ) : (
              <li key={i.id}>
                <a
                  href={`/api/arquivos/${pasta.id}/${encodeURIComponent(i.id)}`}
                  download
                  className="flex items-center gap-3 px-3 py-2.5 hover:bg-superficie-2"
                  aria-label={`Baixar ${i.nome}`}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-superficie-2 text-[10px] font-semibold text-muted" aria-hidden>
                    {extensao(i.nome) || <FileText size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{i.nome}</span>
                    <span className="block text-xs text-muted">
                      {[tamanho(i.tamanho), i.modificadoEm ? `alterado em ${quando(i.modificadoEm)}` : ""].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <Download size={16} className="shrink-0 text-floresta-texto" aria-hidden />
                </a>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

export function ArquivosDaMissao({ missionId }: { missionId: string }) {
  const q = useQuery({ queryKey: ["arquivos", missionId], queryFn: () => listarArquivosDaMissao({ data: { missionId } }) });
  const [aberta, setAberta] = useState<PastaVinculada | null>(null);
  if (q.isPending) return <p className="p-5 text-sm text-muted">Carregando…</p>;
  if (q.isError) return <FalhaAoCarregar mensagem="Não foi possível carregar as pastas da missão." consulta={q} />;
  if (aberta) return <Navegador key={aberta.id} pasta={aberta} onVoltar={() => setAberta(null)} />;
  const { daMissao, doCliente, graphConfigurado } = q.data;
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      <p className="flex items-start gap-2 text-sm text-muted">
        <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          Pastas do SharePoint vinculadas no Prisma à missão e às oportunidades do cliente. Você vê só as que o seu perfil permite.
          {!graphConfigurado && " A leitura do SharePoint ainda não foi configurada no Omni: por enquanto, use “Abrir no SharePoint”."}
        </span>
      </p>
      {daMissao.length === 0 && doCliente.length === 0 ? (
        <div className="rounded-lg border border-linha bg-superficie p-6 text-center text-sm text-muted">
          <Folder size={22} className="mx-auto mb-2" aria-hidden />
          Nenhuma pasta do SharePoint disponível para esta missão.
          <br />O vínculo é feito no Prisma; a missão precisa estar ligada a ele.
        </div>
      ) : (
        <>
          {daMissao.length > 0 && <ListaPastas titulo="Pastas da missão" pastas={daMissao} onAbrir={setAberta} />}
          {doCliente.length > 0 && <ListaPastas titulo="Outras pastas do cliente" pastas={doCliente} onAbrir={setAberta} />}
        </>
      )}
    </div>
  );
}
