import { PERFIS, type PerfilCodigo } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { criarAcessoInterno, definirAtivo, definirPerfis, listPessoas, novoLinkDeSenha, type PessoaAdmin } from "../../lib/admin-fns.ts";
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

  const [linkMostrado, setLinkMostrado] = useState<{ nome: string; login: string; link: string } | null>(null);
  const redefinir = useMutation({
    mutationFn: (p: PessoaAdmin) => novoLinkDeSenha({ data: { personId: p.id } }).then((r) => ({ nome: p.displayName, login: p.interno!.login, link: r.link })),
    onMutate: () => setErro(null),
    onSuccess: setLinkMostrado,
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
      {souAdmin && <NovoAcessoInterno aoCriar={(x) => (setLinkMostrado(x), atualizar())} />}
      {linkMostrado && <LinkDeSenha {...linkMostrado} fechar={() => setLinkMostrado(null)} />}
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
                {(p.entra || p.inativoPor || p.interno) && (
                  <p className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                    {p.interno && <span className="rounded-sm bg-superficie-2 px-1.5 py-0.5 text-muted">Login interno: {p.interno.login} · sem e-mail</span>}
                    {p.interno && !p.interno.temSenha && (
                      <span className={`rounded-sm bg-superficie-2 px-1.5 py-0.5 ${p.interno.linkValeAte ? "text-muted" : "text-vermelho"}`}>
                        {p.interno.linkValeAte ? `Ainda sem senha · link vale até ${ultimoAcesso(p.interno.linkValeAte)}` : "Sem senha e o link venceu: gere outro"}
                      </span>
                    )}
                    {p.interno && <span className="rounded-sm bg-superficie-2 px-1.5 py-0.5 text-muted">{p.interno.temEmailRecuperacao ? "Recupera a senha pelo e-mail pessoal" : "Sem e-mail pessoal: só a Administração gera link"}</span>}
                    {p.interno?.bloqueadaAte && <span className="rounded-sm bg-superficie-2 px-1.5 py-0.5 text-vermelho">Bloqueada por tentativas erradas</span>}
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
            {p.interno && souAdmin && (
              <button
                type="button"
                disabled={redefinir.isPending || !p.active}
                onClick={() => confirm(`Gerar um link novo para ${p.displayName} criar a senha? A senha atual deixa de valer e as sessões abertas saem.`) && redefinir.mutate(p)}
                className="mt-3 rounded-md border border-linha px-3 py-1.5 text-sm font-medium hover:bg-superficie-2 disabled:opacity-60"
              >
                Gerar link de senha
              </button>
            )}
          </li>
        ))}
        {lista.length === 0 && <p className="text-muted">Ninguém encontrado.</p>}
      </ul>
    </section>
  );
}

/** Criar o acesso de quem não tem conta Microsoft da empresa (só admin). */
function NovoAcessoInterno({ aoCriar }: { aoCriar: (x: { nome: string; login: string; link: string }) => void }) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [login, setLogin] = useState("");
  const criar = useMutation({
    mutationFn: () => criarAcessoInterno({ data: { nome, login } }),
    onSuccess: (r) => {
      aoCriar({ nome, login: r.login, link: r.link });
      setNome("");
      setLogin("");
      setAberto(false);
    },
  });
  if (!aberto)
    return (
      <button type="button" onClick={() => setAberto(true)} className="rounded-md border border-floresta px-3 py-1.5 text-sm font-medium text-floresta-texto hover:bg-floresta-clara">
        Criar acesso sem Microsoft
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        criar.mutate();
      }}
      className="space-y-3 rounded-lg border border-linha bg-superficie p-4"
    >
      <p className="font-medium">Acesso sem Microsoft</p>
      <p className="text-sm text-muted">
        Para quem não tem conta Microsoft da Filtrovali: entra com usuário e senha e usa tudo do Omni, menos o e-mail. Depois de criar, marque os perfis
        e as funções como de qualquer pessoa.
      </p>
      <label className="block">
        <span className="text-sm font-medium">Nome</span>
        <input required minLength={2} value={nome} onChange={(e) => setNome(e.target.value)} className="mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Usuário</span>
        <input
          required
          value={login}
          onChange={(e) => setLogin(e.target.value.toLowerCase())}
          pattern="[a-z0-9][a-z0-9._\-]{2,39}"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="ex.: joao.campo"
          className="mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2"
        />
        <span className="mt-1 block text-xs text-muted">3 a 40 letras minúsculas, números, ponto, hífen ou sublinhado.</span>
      </label>
      {criar.isError && <Aviso tipo="erro">{mensagemDeErro(criar.error)}</Aviso>}
      <div className="flex gap-2">
        <button type="submit" disabled={criar.isPending} className="rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
          {criar.isPending ? "Criando…" : "Criar e gerar o link"}
        </button>
        <button type="button" onClick={() => setAberto(false)} className="rounded-md px-3 py-1.5 text-sm hover:bg-superficie-2">
          Cancelar
        </button>
      </div>
    </form>
  );
}

/** O link aparece uma vez só: quem administra passa à pessoa, que cria a própria senha nele (uso único, 7 dias). */
function LinkDeSenha({ nome, login, link, fechar }: { nome: string; login: string; link: string; fechar: () => void }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div role="status" className="space-y-2 rounded-lg border border-floresta bg-floresta-clara p-4 text-floresta-texto">
      <p className="font-medium">
        Link de senha de {nome} (usuário <span className="font-mono">{login}</span>)
      </p>
      <p className="break-all rounded-md bg-superficie px-2 py-1.5 font-mono text-xs text-ink select-all">{link}</p>
      <p className="text-xs">
        Passe à pessoa por um canal seguro (WhatsApp dela, por exemplo). Vale 7 dias e uma vez só: nele ela cria a própria senha e volta para a tela de
        entrar com o usuário preenchido. Este link não aparece de novo.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(link).then(() => setCopiado(true))}
          className="rounded-md bg-floresta px-3 py-1 text-sm font-medium text-white hover:bg-floresta-escura"
        >
          {copiado ? "Copiado" : "Copiar o link"}
        </button>
        <button type="button" onClick={fechar} className="rounded-md border border-floresta px-3 py-1 text-sm font-medium hover:bg-superficie">
          Fechar
        </button>
      </div>
    </div>
  );
}
