import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Paperclip, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { anexosDaTarefa } from "../../lib/tarefas-fns.ts";
import { ImagemComPrevia } from "../comum/ImagemComPrevia.tsx";

/** Anexos da tarefa (0077): imagem em miniatura com prévia, o resto em cartão; anexar pelo clipe ou arrastando. */

const tamanhoLegivel = (b: number) => (b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);
const IMAGEM = /^image\/(jpeg|png|webp|gif)$/;

export function AnexosDaTarefa({ tarefaId }: { tarefaId: string }) {
  const qc = useQueryClient();
  const entrada = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);
  const chave = ["tarefas", "anexos", tarefaId];
  const q = useQuery({ queryKey: chave, queryFn: () => anexosDaTarefa({ data: { id: tarefaId } }) });
  const enviar = useMutation({
    mutationFn: async (arquivos: File[]) => {
      const form = new FormData();
      form.set("taskId", tarefaId);
      for (const a of arquivos) form.append("arquivo", a);
      const r = await fetch("/api/tarefas/anexo", { method: "POST", body: form });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { erro?: string } | null)?.erro ?? "Não foi possível anexar o arquivo.");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: chave }),
  });
  const apagar = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/tarefas/anexo/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.text()) || "Não foi possível apagar o arquivo.");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: chave }),
  });
  const anexos = q.data ?? [];
  const escolher = (lista: FileList | null) => {
    const arquivos = [...(lista ?? [])];
    if (arquivos.length) enviar.mutate(arquivos);
  };
  const erro = enviar.error ?? apagar.error;

  return (
    <section
      aria-label="Anexos"
      className={`mt-5 rounded-md ${arrastando ? "outline-dashed outline-2 outline-floresta" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setArrastando(true);
      }}
      onDragLeave={() => setArrastando(false)}
      onDrop={(e) => {
        e.preventDefault();
        setArrastando(false);
        escolher(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Anexos ({anexos.length})</h3>
        <button
          type="button"
          onClick={() => entrada.current?.click()}
          disabled={enviar.isPending}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-floresta-texto hover:bg-superficie-2 disabled:opacity-60"
        >
          <Paperclip size={15} aria-hidden /> {enviar.isPending ? "Enviando…" : "Anexar"}
        </button>
        <input ref={entrada} type="file" multiple hidden onChange={(e) => (escolher(e.target.files), (e.target.value = ""))} />
      </div>
      {anexos.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {anexos.map((a) => {
            const url = `/api/tarefas/anexo/${a.id}`;
            return (
              <li key={a.id} className="flex items-start gap-2">
                {IMAGEM.test(a.tipo) ? (
                  <ImagemComPrevia src={url} alt={a.nome} nome={a.nome} baixar={`${url}?baixar=1`} className="max-h-40 max-w-full rounded-md border border-linha object-contain" />
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-linha bg-superficie-2 px-2.5 py-1.5">
                    <FileText size={18} aria-hidden className="shrink-0 text-floresta-texto" />
                    <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 hover:underline">
                      <span className="block truncate text-sm">{a.nome}</span>
                      <span className="block text-[11px] text-muted">
                        {tamanhoLegivel(a.tamanho)}
                        {a.autor ? ` · ${a.autor}` : ""}
                      </span>
                    </a>
                    <a href={`${url}?baixar=1`} aria-label={`Baixar ${a.nome}`} title="Baixar" className="rounded p-1 hover:bg-superficie">
                      <Download size={16} aria-hidden />
                    </a>
                  </span>
                )}
                {a.meu && (
                  <button
                    type="button"
                    onClick={() => confirm(`Apagar o anexo "${a.nome}"?`) && apagar.mutate(a.id)}
                    aria-label={`Apagar ${a.nome}`}
                    title="Apagar"
                    className="mt-1 rounded p-1 text-muted hover:bg-superficie-2 hover:text-vermelho"
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {erro && (
        <p role="alert" className="mt-1 text-sm text-vermelho">
          {erro.message}
        </p>
      )}
    </section>
  );
}
