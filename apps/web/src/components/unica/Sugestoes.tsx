import { formatarTelefone, telefoneCanonico } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2, Mail, Send, Sparkles, X } from "lucide-react";

import type { ContatoUnico } from "../../lib/caixa-unica.ts";
import { sugestoesPorNome } from "../../lib/caixa-unica.ts";
import { enviarContatoAoPrisma, identidadesNoPrisma } from "../../lib/prisma-fase6-fns.ts";
import { recusarSugestao, sugestoesRecusadas, telefonesDosEmails, vincularContato } from "../../lib/unica-fns.ts";

/** "Mesma pessoa?": conversa do WhatsApp e e-mail com o mesmo nome. Juntar é um clique; "Não é" some só para mim. */
export function SugestoesDeVinculo({ contatos }: { contatos: ContatoUnico[] }) {
  const qc = useQueryClient();
  const recusadas = useQuery({ queryKey: ["unica", "recusadas"], queryFn: () => sugestoesRecusadas(), staleTime: 5 * 60_000 });
  const juntar = useMutation({
    mutationFn: (s: { nome: string; endereco: string; telefone: string }) =>
      vincularContato({ data: { nome: s.nome, emails: [s.endereco], telefones: [s.telefone], origem: "sugestao" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unica"] }),
  });
  const recusar = useMutation({
    mutationFn: (s: { endereco: string; telefone: string }) => recusarSugestao({ data: { email: s.endereco, telefone: s.telefone } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unica", "recusadas"] }),
  });
  if (!recusadas.data) return null;
  const sugestoes = sugestoesPorNome(contatos, new Set(recusadas.data));
  if (!sugestoes.length) return null;
  return (
    <ul className="border-b border-linha bg-azul/5">
      {sugestoes.map((s) => (
        <li key={`${s.endereco}|${s.telefone}`} className="space-y-1.5 px-4 py-2.5 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <Sparkles size={14} aria-hidden className="text-azul" /> Mesma pessoa?
          </p>
          <p className="text-muted">
            <span className="text-ink">{s.nome}</span> no WhatsApp, {formatarTelefone(s.telefone) ?? s.telefone}, e no e-mail, {s.endereco}.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={juntar.isPending}
              onClick={() => juntar.mutate(s)}
              className="flex items-center gap-1 rounded-md bg-floresta px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              <Check size={14} aria-hidden /> Juntar
            </button>
            <button
              type="button"
              disabled={recusar.isPending}
              onClick={() => recusar.mutate(s)}
              className="flex items-center gap-1 rounded-md border border-linha px-2.5 py-1 text-xs font-medium hover:bg-superficie-2"
            >
              <X size={14} aria-hidden /> Não é
            </button>
          </div>
          {juntar.isError && juntar.variables === s && (
            <p role="alert" className="text-xs text-vermelho">
              {juntar.error.message}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Contexto do contato: o que o Prisma sabe (sugere vincular o telefone ou o e-mail que
 * falta) e "Enviar ao Prisma" o contato do cliente (só para quem vê dados comerciais).
 */
/**
 * O que os e-mails dizem do contato (0076): cargo e empresa da assinatura e os telefones
 * encontrados que ainda não estão na agenda — o da assinatura (o fixo não é vinculado sozinho)
 * e os citados no corpo. Vincular é um clique (fica como "sugestão aceita").
 */
function EncontradoNosEmails({ contato }: { contato: ContatoUnico }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["unica", "telefones-emails", contato.enderecos.join(",")],
    queryFn: () => telefonesDosEmails({ data: { enderecos: contato.enderecos.slice(0, 20) } }),
    enabled: contato.enderecos.length > 0,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const vincular = useMutation({
    mutationFn: (t: { telefone: string; endereco: string }) =>
      vincularContato({
        data: {
          contatoId: contato.contatoId ?? undefined,
          nome: contato.nome,
          empresa: q.data?.empresa ?? undefined,
          emails: [t.endereco],
          telefones: [t.telefone],
          origem: "sugestao",
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unica"] }),
  });
  const d = q.data;
  if (!d || (!d.cargo && !d.empresa && !d.telefones.length)) return null;
  return (
    <div className="space-y-1 rounded-md border border-linha p-2">
      <p className="flex items-center gap-1.5 font-medium">
        <Mail size={14} aria-hidden className="text-azul" /> Encontrado nos e-mails
      </p>
      {(d.cargo || d.empresa) && <p className="text-xs text-muted">{[d.cargo, d.empresa].filter(Boolean).join(" · ")} (assinatura)</p>}
      {d.telefones.map((t) => (
        <div key={t.telefone} className="flex items-center justify-between gap-2">
          <span className="min-w-0">
            <span className="tabular-nums">{formatarTelefone(t.telefone) ?? t.telefone}</span>{" "}
            <span className="text-xs text-muted">
              · {t.origem === "assinatura" ? (t.celular ? "assinatura" : "fixo, da assinatura") : "citado num e-mail"}
            </span>
          </span>
          <button
            type="button"
            disabled={vincular.isPending}
            onClick={() => vincular.mutate(t)}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-floresta-texto hover:bg-superficie-2"
          >
            <Link2 size={13} aria-hidden /> Vincular
          </button>
        </div>
      ))}
      {vincular.isError && (
        <p role="alert" className="text-xs text-vermelho">
          {vincular.error.message}
        </p>
      )}
    </div>
  );
}

export function ContatoEPrisma({ contato }: { contato: ContatoUnico }) {
  const qc = useQueryClient();
  const email = contato.enderecos[0];
  const telefone = contato.telefones[0];
  const q = useQuery({
    queryKey: ["unica", "prisma", email ?? null, telefone ?? null],
    queryFn: () => identidadesNoPrisma({ data: email ? { email } : { telefone: telefone! } }),
    enabled: Boolean(email || telefone),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const vincular = useMutation({
    mutationFn: (v: { email?: string; telefone?: string }) =>
      vincularContato({
        data: {
          contatoId: contato.contatoId ?? undefined,
          nome: contato.nome,
          emails: [...contato.enderecos.slice(0, 1), ...(v.email ? [v.email] : [])],
          telefones: [...contato.telefones.slice(0, 1), ...(v.telefone ? [v.telefone] : [])],
          origem: "prisma",
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unica"] }),
  });
  const enviar = useMutation({
    mutationFn: () => enviarContatoAoPrisma({ data: { contatoId: contato.contatoId! } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unica"] }),
  });
  const p = q.data?.contato;
  const meus = new Set([...contato.telefones, ...contato.enderecos]);
  const telefonesNovos = (p?.telefones ?? []).map((t) => telefoneCanonico(t)).filter((t): t is string => Boolean(t) && !meus.has(t!));
  const emailsNovos = (p?.emails ?? []).filter((e) => !meus.has(e));
  return (
    <div className="space-y-2 text-sm">
      <EncontradoNosEmails contato={contato} />
      {contato.automaticos.length > 0 && (
        <p className="text-xs text-muted">
          Vinculado sozinho pela assinatura do e-mail: {contato.automaticos.map((v) => (v.includes("@") ? v : (formatarTelefone(v) ?? v))).join(", ")}.
        </p>
      )}
      {(telefonesNovos.length > 0 || emailsNovos.length > 0) && (
        <div className="space-y-1 rounded-md border border-azul/40 p-2">
          <p className="flex items-center gap-1.5 font-medium">
            <Sparkles size={14} aria-hidden className="text-azul" /> O Prisma conhece este contato
          </p>
          {telefonesNovos.slice(0, 2).map((t) => (
            <button key={t} type="button" disabled={vincular.isPending} onClick={() => vincular.mutate({ telefone: t })} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-superficie-2">
              <Link2 size={14} aria-hidden /> Vincular telefone {formatarTelefone(t) ?? t}
            </button>
          ))}
          {emailsNovos.slice(0, 2).map((e) => (
            <button key={e} type="button" disabled={vincular.isPending} onClick={() => vincular.mutate({ email: e })} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-superficie-2">
              <Link2 size={14} aria-hidden /> Vincular e-mail {e}
            </button>
          ))}
          {vincular.isError && <p role="alert" className="text-xs text-vermelho">{vincular.error.message}</p>}
        </div>
      )}
      {q.data?.podeVer && contato.contatoId && email && !contato.noPrisma && !p && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={enviar.isPending}
            onClick={() => enviar.mutate()}
            className="flex items-center gap-1.5 rounded-md border border-linha px-2.5 py-1 text-xs font-medium hover:bg-superficie-2 disabled:opacity-60"
          >
            <Send size={14} aria-hidden /> {enviar.isPending ? "Enviando…" : "Enviar ao Prisma"}
          </button>
          {enviar.isSuccess && <p className="text-xs text-muted">Enviado ao Prisma{enviar.data.empresa ? ` (${enviar.data.empresa})` : ""}.</p>}
          {enviar.isError && <p role="alert" className="text-xs text-vermelho">{enviar.error.message}</p>}
        </div>
      )}
    </div>
  );
}
