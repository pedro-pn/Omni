import { useQuery, useQueryClient } from "@tanstack/react-query";

import { projetoDaMissao } from "../../lib/tarefas-fns.ts";
import { CHAVE_CONTEXTO, TarefasPainel, useContextoTarefas } from "./Tarefas.tsx";
import { Carregando } from "../comum/Carregando.tsx";

/**
 * Aba Tarefas da missão: o projeto de tarefas da missão (criado na primeira
 * vez). Quem vê o Interno vê e recebe as tarefas (migration 0014).
 */
/** Projeto de tarefas da missão (cria na primeira vez) e atualiza o contexto das tarefas. */
export function useProjetoDaMissao(missionId: string, ativo = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["projeto-da-missao", missionId],
    queryFn: async () => {
      const r = await projetoDaMissao({ data: { missionId } });
      await queryClient.invalidateQueries({ queryKey: CHAVE_CONTEXTO });
      return r;
    },
    staleTime: Infinity,
    enabled: ativo,
  });
}

export function TarefasDaMissao({ missionId, meuId }: { missionId: string; meuId: string }) {
  const projeto = useProjetoDaMissao(missionId);
  const ctx = useContextoTarefas(Boolean(projeto.data));

  if (projeto.isError) {
    return (
      <p role="alert" className="px-6 py-10 text-center text-vermelho">
        {projeto.error instanceof Error ? projeto.error.message : "Não foi possível abrir as tarefas da missão."}
      </p>
    );
  }
  if (!projeto.data || !ctx.data?.projetos.some((p) => p.id === projeto.data.id)) {
    return <Carregando rotulo="Carregando tarefas" className="px-6 py-10" />;
  }
  return <TarefasPainel ctx={ctx.data} vista={{ tipo: "projeto", id: projeto.data.id }} meuId={meuId} embutido />;
}
