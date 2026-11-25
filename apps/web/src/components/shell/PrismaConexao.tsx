import { descreverVencimento } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Unlink } from "lucide-react";

import { desconectarDoPrisma, getConexaoPrisma } from "../../lib/prisma-fns.ts";

/** Item do menu do perfil: conexão individual com o Prisma CRM. */
export function PrismaConexao() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["prisma-conexao"], queryFn: () => getConexaoPrisma() });
  const desconectar = useMutation({
    mutationFn: () => desconectarDoPrisma(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prisma-conexao"] }),
  });

  if (!status.data) return null;
  const { ambiente, conexao } = status.data;
  const sufixo = ambiente === "sandbox" ? " (testes)" : "";

  if (conexao?.valida) {
    const vencimento = descreverVencimento(conexao.expiresAt);
    return (
      <div className="mt-1 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm">
        <span>
          Prisma{sufixo}: conectado até {vencimento.texto}
          {vencimento.perto && (
            <a href="/integracoes/prisma/conectar" className="ml-1 text-azul underline">
              Renovar
            </a>
          )}
        </span>
        <button
          type="button"
          onClick={() => desconectar.mutate()}
          disabled={desconectar.isPending}
          title="Desconectar do Prisma"
          aria-label="Desconectar do Prisma"
          className="rounded-md p-1 text-muted hover:bg-superficie-2 hover:text-ink"
        >
          <Unlink size={15} />
        </button>
      </div>
    );
  }

  return (
    <a
      href="/integracoes/prisma/conectar"
      role="menuitem"
      className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-azul hover:bg-superficie-2"
    >
      <Link2 size={16} /> {conexao ? "Reconectar ao Prisma" : "Conectar ao Prisma"}
      {sufixo}
    </a>
  );
}
