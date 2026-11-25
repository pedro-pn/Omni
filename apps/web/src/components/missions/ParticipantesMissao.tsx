import { formatarTelefone } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Mail, MessageCircle, Pencil, Send, Users } from "lucide-react";
import { useState, type FormEvent } from "react";

import { completarParticipante, participantesDaMissao, type Participante } from "../../lib/participantes-fns.ts";
import { enviarParticipanteAoPrisma, tirarParticipanteDoPrisma } from "../../lib/prisma-fase6-fns.ts";
import { NoPrismaInfo } from "../prisma/NoPrisma.tsx";

/**
 * Participantes da missão (INSTRUCOES §6.7): quem aparece nos e-mails e nos
 * grupos do WhatsApp da missão, separado em cliente, terceiros e Filtrovali.
 * A equipe completa nome, cargo e empresa, ou tira quem não é participante.
 */

const GRUPOS: Array<{ lado: Participante["lado"]; titulo: string }> = [
  { lado: "cliente", titulo: "Cliente" },
  { lado: "terceiro", titulo: "Terceiros" },
  { lado: "a_definir", titulo: "A definir" },
  { lado: "filtrovali", titulo: "Filtrovali" },
];
const ORIGEM: Record<Participante["origens"][number], string> = { remetente: "escreveu", destinatario: "recebeu", copia: "em cópia", whatsapp: "WhatsApp" };
const campo = "w-full rounded-md border border-linha bg-superficie px-2 py-1";

export function ParticipantesMissao({ missionId }: { missionId: string }) {
  const q = useQuery({ queryKey: ["participantes", missionId], queryFn: () => participantesDaMissao({ data: { missionId } }), staleTime: 60_000 });
  const [verOcultos, setVerOcultos] = useState(false);
  const [verFiltrovali, setVerFiltrovali] = useState(false);
  if (!q.data?.podeVer) return null;
  const lista = q.data.participantes;
  const ocultos = lista.filter((p) => p.oculto).length;
  const visiveis = lista.filter((p) => p.oculto === verOcultos);
  return (
    <section className="rounded-lg border border-linha bg-superficie p-5" aria-labelledby="titulo-participantes">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="titulo-participantes" className="flex items-center gap-2 font-semibold">
          <Users size={16} aria-hidden className="text-floresta-texto" /> Participantes
        </h3>
        {ocultos > 0 && (
          <button type="button" onClick={() => setVerOcultos(!verOcultos)} className="text-xs text-muted underline">
            {verOcultos ? "Voltar à lista" : `Fora da lista (${ocultos})`}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        Quem aparece {q.data.incluiEmails ? "nos e-mails da missão (remetente, destinatários e cópia) e " : ""}nos grupos do WhatsApp ligados a ela. Complete o cargo e a
        empresa, ou tire quem não participa.
      </p>
      {!visiveis.length && <p className="mt-3 text-sm text-muted">{verOcultos ? "Ninguém fora da lista." : "Ninguém ainda. Os participantes aparecem quando houver e-mails ou mensagens no grupo da missão."}</p>}
      {GRUPOS.map((g) => {
        const doGrupo = visiveis.filter((p) => p.lado === g.lado);
        if (!doGrupo.length) return null;
        const recolhido = g.lado === "filtrovali" && !verFiltrovali && !verOcultos;
        return (
          <div key={g.lado} className="mt-4">
            <p className="rotulo flex items-center gap-2 text-muted">
              {g.titulo} · {doGrupo.length}
              {g.lado === "filtrovali" && !verOcultos && (
                <button type="button" onClick={() => setVerFiltrovali(!verFiltrovali)} className="normal-case tracking-normal underline">
                  {recolhido ? "mostrar" : "esconder"}
                </button>
              )}
            </p>
            {!recolhido && (
              <ul className="mt-1 divide-y divide-linha">
                {doGrupo.map((p) => (
                  <Linha key={p.chave} p={p} missionId={missionId} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Cliente: enviar ao Prisma (contato + participante da missão), tirar, e o que o Prisma já sabe. */
function PrismaDoParticipante({ p, missionId }: { p: Participante; missionId: string }) {
  const qc = useQueryClient();
  const [ver, setVer] = useState(false);
  const atualizar = () => void qc.invalidateQueries({ queryKey: ["participantes", missionId] });
  const enviar = useMutation({
    mutationFn: () => enviarParticipanteAoPrisma({ data: { missionId, chave: p.chave, nome: p.nome ?? "", email: p.email, telefone: p.telefone, cargo: p.cargo } }),
    onSuccess: atualizar,
  });
  const tirar = useMutation({ mutationFn: () => tirarParticipanteDoPrisma({ data: { missionId, chave: p.chave } }), onSuccess: atualizar });
  const erro = [enviar.error, tirar.error].find(Boolean);
  return (
    <span className="mt-1 block space-y-1">
      <span className="flex flex-wrap items-center gap-2 text-xs">
        {p.prisma ? (
          <>
            <span className="flex items-center gap-1 text-floresta-texto">
              <Check size={13} aria-hidden /> Participante no Prisma
            </span>
            <button type="button" disabled={tirar.isPending} onClick={() => confirm("Tirar esta pessoa dos participantes da missão no Prisma? O contato continua lá.") && tirar.mutate()} className="text-muted underline">
              Tirar do Prisma
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={enviar.isPending || !p.nome}
            title={p.nome ? "Cria ou completa o contato na empresa do cliente e marca como participante desta missão no Prisma" : "Complete o nome antes"}
            onClick={() => enviar.mutate()}
            className="flex items-center gap-1 rounded-md border border-linha px-2 py-0.5 font-medium hover:bg-superficie-2 disabled:opacity-50"
          >
            <Send size={12} aria-hidden /> {enviar.isPending ? "Enviando…" : "Enviar ao Prisma"}
          </button>
        )}
        <button type="button" onClick={() => setVer(!ver)} className="text-muted underline">
          {ver ? "Esconder Prisma" : "Ver no Prisma"}
        </button>
      </span>
      {erro && <span className="block text-xs text-vermelho">{erro instanceof Error ? erro.message : "Não foi possível falar com o Prisma."}</span>}
      {ver && <NoPrismaInfo email={p.email} telefone={p.email ? null : p.telefone} compacto />}
    </span>
  );
}

function Linha({ p, missionId }: { p: Participante; missionId: string }) {
  const qc = useQueryClient();
  const [editando, setEditando] = useState(false);
  const salvar = useMutation({
    mutationFn: (v: { nome: string | null; cargo: string | null; empresa: string | null; lado: "cliente" | "filtrovali" | "terceiro" | null; oculto: boolean }) =>
      completarParticipante({ data: { missionId, chave: p.chave, ...v } }),
    onSuccess: () => {
      setEditando(false);
      void qc.invalidateQueries({ queryKey: ["participantes", missionId] });
    },
  });
  const contato = p.email ?? (p.telefone ? formatarTelefone(p.telefone) : null);
  const enviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const texto = (k: string) => String(f.get(k) ?? "").trim() || null;
    const lado = texto("lado") as "cliente" | "filtrovali" | "terceiro" | null;
    salvar.mutate({ nome: texto("nome"), cargo: texto("cargo"), empresa: texto("empresa"), lado, oculto: f.get("oculto") === "on" });
  };
  return (
    <li className="py-2 text-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-muted">{p.email ? <Mail size={15} aria-hidden /> : <MessageCircle size={15} aria-hidden />}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {p.nome ?? contato ?? "Sem nome"}
            {p.setor && <span className="ml-1.5 rounded-sm bg-superficie-2 px-1 text-[11px] font-normal text-muted">e-mail de setor</span>}
          </span>
          {(p.cargo || p.empresa) && (
            <span className="block text-xs">
              {[p.cargo, p.empresa].filter(Boolean).join(" · ")}
              {p.pelaAssinatura && <span className="text-muted"> · pela assinatura do e-mail</span>}
            </span>
          )}
          {p.lado === "cliente" && (p.email || p.telefone) && <PrismaDoParticipante p={p} missionId={missionId} />}
          <span className="block truncate text-xs text-muted">
            {[p.nome ? [contato, p.email && p.telefone ? formatarTelefone(p.telefone) ?? p.telefone : null].filter(Boolean).join(" · ") : null, p.origens.map((o) => ORIGEM[o]).join(", "), `${p.vezes}×`, `última em ${new Date(p.ultimaVez).toLocaleDateString("pt-BR")}`].filter(Boolean).join(" · ")}
          </span>
        </span>
        <button type="button" onClick={() => setEditando(!editando)} aria-label={`Completar ${p.nome ?? contato ?? "participante"}`} className="shrink-0 rounded-md p-1 text-muted hover:bg-superficie-2 hover:text-ink">
          <Pencil size={14} aria-hidden />
        </button>
      </div>
      {editando && (
        <form onSubmit={enviar} className="mt-2 grid gap-2 rounded-md bg-superficie-2 p-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs">
            Nome
            <input name="nome" defaultValue={p.nome ?? ""} maxLength={120} className={campo} />
          </label>
          <label className="grid gap-1 text-xs">
            Cargo
            <input name="cargo" defaultValue={p.cargo ?? ""} maxLength={120} placeholder="Ex.: Coordenador de manutenção" className={campo} />
          </label>
          <label className="grid gap-1 text-xs">
            Empresa
            <input name="empresa" defaultValue={p.empresa ?? ""} maxLength={120} className={campo} />
          </label>
          <label className="grid gap-1 text-xs">
            É do
            <select name="lado" defaultValue={p.lado === "a_definir" ? "" : p.lado} className={campo}>
              <option value="">A definir</option>
              <option value="cliente">Cliente</option>
              <option value="terceiro">Terceiro (hotel, transportadora, fornecedor…)</option>
              <option value="filtrovali">Filtrovali</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input type="checkbox" name="oculto" defaultChecked={p.oculto} /> Não é participante desta missão (tirar da lista)
          </label>
          {salvar.isError && <p className="text-xs text-vermelho sm:col-span-2">{salvar.error instanceof Error ? salvar.error.message : "Não foi possível salvar."}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" disabled={salvar.isPending} className="rounded-md bg-floresta px-3 py-1 text-sm font-medium text-white">
              Salvar
            </button>
            <button type="button" onClick={() => setEditando(false)} className="rounded-md border border-linha px-3 py-1 text-sm">
              Cancelar
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
