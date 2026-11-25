import type { ReactNode } from "react";

/** Mensagem legível de um erro vindo de uma server function. */
export function mensagemDeErro(error: unknown): string {
  const texto = error instanceof Error ? error.message : String(error);
  if (!texto || /failed query|fetch|network/i.test(texto)) return "Não foi possível salvar. Tente de novo.";
  return texto;
}

export function Aviso({ tipo, children }: { tipo: "erro" | "ok"; children: ReactNode }) {
  return (
    <p
      role={tipo === "erro" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 ${tipo === "erro" ? "border-vermelho/40 text-vermelho" : "border-floresta/40 text-floresta-texto"}`}
    >
      {children}
    </p>
  );
}

export const campo = "rounded-md border border-linha bg-superficie-2 px-3 py-2";
export const botaoPrimario = "rounded-md bg-floresta px-4 py-2 font-medium text-white hover:bg-floresta-escura disabled:opacity-60";
export const botaoSecundario = "rounded-md border border-linha px-3 py-1.5 text-sm hover:bg-superficie-2 disabled:opacity-60";
