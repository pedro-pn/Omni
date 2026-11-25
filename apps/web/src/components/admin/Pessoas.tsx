import { PERFIS, type PerfilCodigo } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { definirAtivo, definirPerfis, listPessoas, type PessoaAdmin } from "../../lib/admin-fns.ts";
import { definirPermissaoGravacao } from "../../lib/whatsapp-fns.ts";
import { Aviso, mensagemDeErro } from "./ui.tsx";

const ultimoAcesso = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
    : "Nunca entrou";

export function Pessoas({ meuId, souAdmin }: { meuId: string; souAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const pessoas = useQuery({ queryKey: ["admin", "pessoas"], queryFn: () => listPessoas() });
  const atualizar = () => queryClient.invalidateQueries({ queryKey: ["admin", "pessoas"] });

  const perfis = useMutation({
    mutationFn: (v: { personId: string; perfis: PerfilCodigo[] }) => definirPerfis({ data: v }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });
  const gravar = useMutation({
    mutationFn: (v: { personId: string; permitir: boolean }) => definirPermissaoGravacao({ data: v }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });
  const ativo = useMutation({
    mutationFn: (v: { personId: string; active: boolean }) => definirAtivo({ data: v }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });

  if (pessoas.isPending) return <p className="text-muted">Carregando pessoas…</p>;
  if (pessoas.isError) return <Aviso tipo="erro">{mensagemDeErro(pessoas.error)}</Aviso>;

  const termo = busca.trim().toLowerCase();
  const lista = pessoas.data.filter(
    (p) => !termo || p.displayName.toLowerCase().includes(termo) || p.email.toLowerCase().includes(termo),
  );

  const alternar = (p: PessoaAdmin, perfil: PerfilCodigo) =>
    perfis.mutate({
      personId: p.id,
      perfis: p.perfis.includes(perfil) ? p.perfis.filter((x) => x !== perfil) : [...p.perfis, perfil],
    });

  return (
    <section className="space-y-4">
      <p className="text-muted">
        Quem está liberado no app "Omni" do Entra aparece aqui antes do primeiro acesso (a lista é lida de hora em hora): marque os perfis e,
        em Funções, o papel de cada um, e a pessoa já entra com tudo pronto. Sem perfil, ela entra e não vê dados. Tirada do app no Entra, é desativada
        sozinha.
      </p>
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      <input
        type="search"
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar por nome ou e-mail…"
        aria-label="Buscar pessoa"
        className="w-full rounded-md border border-linha bg-superficie px-3 py-2"
      />
      <ul className="space-y-3">
        {lista.map((p) => (
          <li key={p.id} className={`rounded-lg border border-linha bg-superficie p-4 ${p.active ? "" : "opacity-60"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">
                  {p.displayName}
                  {p.id === meuId && <span className="ml-2 text-xs text-muted">(você)</span>}
                </p>
                <p className="truncate text-sm text-muted">{p.email}</p>
                <p className="text-xs text-muted">Último acesso: {ultimoAcesso(p.lastLoginAt)}</p>
                <p className="text-xs text-muted">
                  Termo de uso: {p.termoAceitoEm ? `aceito em ${ultimoAcesso(p.termoAceitoEm)}` : "ainda não aceito"}
                </p>
                {(p.entra || p.inativoPor) && (
                  <p className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                    {p.entra === "atribuida" && <span className="rounded-sm bg-superficie-2 px-1.5 py-0.5 text-muted">Liberada no Entra</span>}
                    {p.entra === "fora" && <span className="rounded-sm bg-superficie-2 px-1.5 py-0.5 text-vermelho">Fora do app no Entra</span>}
                    {p.inativoPor === "entra" && <span className="rounded-sm bg-superficie-2 px-1.5 py-0.5 text-muted">Desativada pelo Entra (volta sozinha se for atribuída de novo)</span>}
                    {p.inativoPor === "admin" && <span className="rounded-sm bg-superficie-2 px-1.5 py-0.5 text-muted">Desativada pela Administração</span>}
                  </p>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={p.active}
                  disabled={p.id === meuId || ativo.isPending}
                  onChange={(e) => ativo.mutate({ personId: p.id, active: e.target.checked })}
                />
                Ativa
              </label>
            </div>
            <fieldset className="mt-3">
              <legend className="rotulo text-muted">Perfis</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(Object.keys(PERFIS) as PerfilCodigo[]).map((perfil) => {
                  const marcado = p.perfis.includes(perfil);
                  const bloqueado = (perfil === "admin" && (!souAdmin || p.id === meuId)) || perfis.isPending || !p.active;
                  return (
                    <label
                      key={perfil}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
                        marcado ? "border-floresta bg-floresta-clara text-floresta-texto" : "border-linha"
                      } ${bloqueado ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <input type="checkbox" className="sr-only" checked={marcado} disabled={bloqueado} onChange={() => alternar(p, perfil)} />
                      {PERFIS[perfil]}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={p.podeGravar}
                disabled={gravar.isPending || !p.active}
                onChange={(e) => gravar.mutate({ personId: p.id, permitir: e.target.checked })}
              />
              Pode gravar as próprias ligações do WhatsApp
              <span className="text-xs text-muted">(em cada ligação, só com o aviso aos participantes; a gravação é só dela)</span>
            </label>
          </li>
        ))}
        {lista.length === 0 && <p className="text-muted">Ninguém encontrado.</p>}
      </ul>
    </section>
  );
}
