import { parsePrismaConsent, prismaConsentReturn, PRISMA_REDIRECT } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { autorizarPrisma, listarChaves, revogarChave } from "../../lib/api-fns.ts";
import type { Me } from "../../lib/session-fns.ts";
import { apagarHistoricoDoAparelho } from "../../lib/whatsapp-aparelho.ts";

/**
 * Consentimento do Prisma, no mesmo endereço do Foco (`/?integracao=prisma…`),
 * para o Prisma seguir funcionando quando o domínio do Foco apontar para o Omni.
 * `&manage=1` mostra a conexão e permite revogar.
 */

const erroDe = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente de novo.");

export function ConsentimentoPrisma({ me, busca }: { me: Me; busca: string }) {
  const queryClient = useQueryClient();
  const pedido = parsePrismaConsent(busca);
  const gerenciar = new URLSearchParams(busca).get("manage") === "1";
  const mesmoEmail = pedido?.email.toLowerCase() === me.email.toLowerCase();
  const chaves = useQuery({ queryKey: ["chaves-api"], queryFn: () => listarChaves(), enabled: gerenciar });
  const conectado = chaves.data?.some((c) => c.prisma && !c.revogadaEm) ?? false;

  const autorizar = useMutation({
    mutationFn: () => autorizarPrisma({ data: { busca } }),
    onSuccess: ({ codigo, estado }) => window.location.replace(prismaConsentReturn(estado, { code: codigo })),
  });
  const revogar = useMutation({
    mutationFn: () => revogarChave({ data: { prisma: true } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["chaves-api"] }),
  });

  const botao = "w-full rounded-md px-4 py-2.5 font-medium disabled:opacity-60";
  return (
    <main className="flex min-h-screen items-center justify-center bg-floresta px-4 py-10">
      <section className="w-full max-w-md rounded-lg bg-superficie p-6 text-ink shadow-sm">
        <ShieldCheck size={32} className="text-floresta-texto" aria-hidden />
        <p className="rotulo mt-3 text-muted">Omni · Integrações</p>
        <h1 className="text-lg font-semibold">{gerenciar ? "Conexão com o Prisma" : "Autorizar o Prisma"}</h1>
        <p className="mt-1 text-sm text-muted">
          Conta no Omni: <b className="text-ink">{me.email}</b>
        </p>

        {gerenciar ? (
          <div className="mt-4 grid gap-3 text-sm">
            <p>{chaves.isLoading ? "Consultando…" : conectado ? "O Prisma está autorizado a consultar suas atividades." : "Não há autorização ativa do Prisma."}</p>
            {conectado && (
              <button type="button" disabled={revogar.isPending} onClick={() => revogar.mutate()} className={`${botao} bg-vermelho text-white`}>
                {revogar.isPending ? "Revogando…" : "Revogar acesso do Prisma"}
              </button>
            )}
            {revogar.isSuccess && <p role="status">Acesso do Prisma revogado. Suas tarefas continuam no Omni.</p>}
            <a href="/" className="text-floresta-texto underline">
              Voltar às minhas tarefas
            </a>
          </div>
        ) : pedido ? (
          <div className="mt-4 grid gap-3 text-sm">
            <p>O Prisma poderá consultar suas atividades, prazos e situação de conclusão. Não poderá criar, editar, concluir ou apagar tarefas e projetos.</p>
            <p className="text-muted">O acesso fica ativo até você desconectar no Prisma ou revogar aqui no Omni.</p>
            {!mesmoEmail && (
              <p role="alert" className="text-vermelho">
                Entre no Omni com <b>{pedido.email}</b>, o mesmo e-mail usado no Prisma.
              </p>
            )}
            <button
              type="button"
              disabled={autorizar.isPending || !mesmoEmail}
              onClick={() => autorizar.mutate()}
              className={`${botao} bg-floresta text-white hover:bg-floresta-escura`}
            >
              {autorizar.isPending ? "Autorizando…" : "Autorizar consulta das minhas atividades"}
            </button>
            <button
              type="button"
              disabled={autorizar.isPending}
              onClick={() => window.location.replace(prismaConsentReturn(pedido.state, { error: "access_denied" }))}
              className={`${botao} border border-linha hover:bg-superficie-2`}
            >
              Cancelar e voltar ao Prisma
            </button>
            {!mesmoEmail && (
              <form
                method="post"
                action="/auth/sair"
                onSubmit={(e) => {
                  // O histórico do WhatsApp baixado neste aparelho sai junto.
                  e.preventDefault();
                  const form = e.currentTarget;
                  void apagarHistoricoDoAparelho().finally(() => form.submit());
                }}
              >
                <button type="submit" className="text-floresta-texto underline">
                  Entrar com outra conta
                </button>
              </form>
            )}
            {autorizar.isError && (
              <p role="alert" className="text-vermelho">
                {erroDe(autorizar.error)}
              </p>
            )}
          </div>
        ) : (
          <div className="mt-4 grid gap-3 text-sm">
            <p role="alert" className="text-vermelho">
              Este pedido de conexão é inválido. Volte ao Prisma e inicie a conexão de novo.
            </p>
            <a href={PRISMA_REDIRECT} className="text-floresta-texto underline">
              Voltar ao Prisma
            </a>
          </div>
        )}
      </section>
    </main>
  );
}
