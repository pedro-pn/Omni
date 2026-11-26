import { DESCRICAO_DO_MODULO, PERFIS, type PerfilCodigo } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { configuracaoDosModulos, salvarModulo, type ConfigModulo } from "../../lib/modulos-fns.ts";
import { Aviso, botaoPrimario, botaoSecundario, campo, mensagemDeErro } from "./ui.tsx";
import { Carregando } from "../comum/Carregando.tsx";

/**
 * Liberação por módulo (Fase 11): cada módulo vale para todos, só para alguns perfis e
 * pessoas, ou para ninguém — para o Omni entrar aos poucos. Quem administra sempre vê.
 */
export function Modulos() {
  const q = useQuery({ queryKey: ["admin", "modulos"], queryFn: () => configuracaoDosModulos() });
  if (q.isPending) return <Carregando />;
  if (q.isError) return <Aviso tipo="erro">{mensagemDeErro(q.error)}</Aviso>;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-linha bg-superficie p-4 text-sm">
        <p className="font-medium">Como funciona</p>
        <p className="mt-1 text-muted">
          Cada módulo pode valer para todos, só para alguns perfis e pessoas, ou para ninguém. Quem não tem o módulo não o vê na tela, não recebe as
          notificações dele no celular e o servidor recusa o acesso. Quem administra o Omni sempre vê todos, para configurar e testar.
        </p>
      </div>
      {!q.data.podeMudar && <Aviso tipo="erro">Só quem administra o Omni muda a liberação dos módulos.</Aviso>}
      <ul className="space-y-3">
        {q.data.modulos.map((m) => (
          <ItemModulo key={m.modulo} config={m} pessoas={q.data.pessoas} podeMudar={q.data.podeMudar} />
        ))}
      </ul>
    </div>
  );
}

function ItemModulo({ config, pessoas, podeMudar }: { config: ConfigModulo; pessoas: { id: string; nome: string; email: string }[]; podeMudar: boolean }) {
  const qc = useQueryClient();
  const [modo, setModo] = useState(config.modo);
  const [perfis, setPerfis] = useState<string[]>(config.perfis);
  const [escolhidas, setEscolhidas] = useState<string[]>(config.pessoas);
  const [busca, setBusca] = useState("");
  const salvar = useMutation({
    mutationFn: () => salvarModulo({ data: { modulo: config.modulo, modo, perfis: perfis as PerfilCodigo[], pessoas: escolhidas } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "modulos"] }),
  });
  const mudou = modo !== config.modo || perfis.join() !== config.perfis.join() || escolhidas.join() !== config.pessoas.join();
  const termo = busca.trim().toLowerCase();
  const achadas = termo ? pessoas.filter((p) => !escolhidas.includes(p.id) && `${p.nome} ${p.email}`.toLowerCase().includes(termo)).slice(0, 6) : [];
  const nome = (id: string) => pessoas.find((p) => p.id === id)?.nome ?? "Pessoa desativada";
  const resumo = config.modo === "todos" ? "Liberado para todos" : config.modo === "ninguem" ? "Desligado" : "Só para alguns";
  return (
    <li className="rounded-lg border border-linha bg-superficie p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{config.nome}</p>
        <span className={`text-xs font-medium ${config.modo === "todos" ? "text-floresta-texto" : config.modo === "ninguem" ? "text-vermelho" : "text-azul"}`}>{resumo}</span>
      </div>
      <p className="text-sm text-muted">{DESCRICAO_DO_MODULO[config.modulo]}</p>
      <fieldset disabled={!podeMudar} className="mt-3 space-y-3 text-sm">
        <legend className="sr-only">Liberação de {config.nome}</legend>
        <div className="flex flex-wrap gap-4">
          {(["todos", "restrito", "ninguem"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1.5">
              <input type="radio" name={`modo-${config.modulo}`} checked={modo === v} onChange={() => setModo(v)} />
              {v === "todos" ? "Todos" : v === "restrito" ? "Só alguns perfis ou pessoas" : "Ninguém"}
            </label>
          ))}
        </div>
        {modo === "restrito" && (
          <div className="space-y-3 rounded-md bg-superficie-2 p-3">
            <div>
              <p className="mb-1 font-medium">Perfis</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {(Object.entries(PERFIS) as [PerfilCodigo, string][])
                  .filter(([c]) => c !== "admin")
                  .map(([codigo, rotulo]) => (
                    <label key={codigo} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={perfis.includes(codigo)}
                        onChange={(e) => setPerfis(e.target.checked ? [...perfis, codigo] : perfis.filter((x) => x !== codigo))}
                      />
                      {rotulo}
                    </label>
                  ))}
              </div>
            </div>
            <div>
              <p className="mb-1 font-medium">Pessoas</p>
              {escolhidas.length > 0 && (
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {escolhidas.map((id) => (
                    <li key={id} className="flex items-center gap-1 rounded-full bg-superficie px-2.5 py-0.5">
                      {nome(id)}
                      <button type="button" aria-label={`Tirar ${nome(id)}`} onClick={() => setEscolhidas(escolhidas.filter((x) => x !== id))} className="text-muted hover:text-vermelho">
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Acrescentar pessoa (nome ou e-mail)…" aria-label={`Acrescentar pessoa em ${config.nome}`} className={`${campo} w-full`} />
              {achadas.length > 0 && (
                <ul className="mt-1 rounded-md border border-linha bg-superficie">
                  {achadas.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setEscolhidas([...escolhidas, p.id]);
                          setBusca("");
                        }}
                        className="block w-full px-3 py-1.5 text-left hover:bg-superficie-2"
                      >
                        {p.nome} <span className="text-xs text-muted">· {p.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {salvar.isError && <Aviso tipo="erro">{mensagemDeErro(salvar.error)}</Aviso>}
        {mudou && (
          <div className="flex gap-2">
            <button type="button" disabled={salvar.isPending} onClick={() => salvar.mutate()} className={botaoPrimario}>
              {salvar.isPending ? "Salvando…" : "Salvar"}
            </button>
            <button
              type="button"
              onClick={() => {
                setModo(config.modo);
                setPerfis(config.perfis);
                setEscolhidas(config.pessoas);
              }}
              className={botaoSecundario}
            >
              Desfazer
            </button>
          </div>
        )}
      </fieldset>
    </li>
  );
}
