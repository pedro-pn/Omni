import { Loader2, RotateCw } from "lucide-react";
import { useState } from "react";

/**
 * "Tentar de novo" com retorno visível: enquanto tenta, o botão fica desativado,
 * com o ícone girando e "Tentando…"; se ainda falhar, diz a hora da última
 * tentativa (a pessoa vê que o clique funcionou, mesmo com a mesma mensagem de erro).
 */
export function TentarDeNovo({ tentar, tentando, falhou }: { tentar: () => Promise<unknown>; tentando: boolean; falhou: boolean }) {
  const [ultima, setUltima] = useState<Date | null>(null);
  const [clicou, setClicou] = useState(false);
  const ocupado = tentando || clicou;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        disabled={ocupado}
        aria-busy={ocupado}
        onClick={async () => {
          setClicou(true);
          try {
            await tentar();
          } finally {
            setClicou(false);
            setUltima(new Date());
          }
        }}
        className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm hover:bg-superficie-2 disabled:cursor-wait disabled:opacity-70"
      >
        {ocupado ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <RotateCw size={15} aria-hidden />}
        {ocupado ? "Tentando…" : "Tentar de novo"}
      </button>
      <p role="status" aria-live="polite" className="text-xs text-muted">
        {!ocupado && falhou && ultima
          ? `Ainda sem resposta às ${ultima.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`
          : ""}
      </p>
    </div>
  );
}

/** Mensagem de falha ao carregar + "Tentar de novo" com retorno, para uma consulta do React Query. */
export function FalhaAoCarregar({
  mensagem,
  consulta,
  className = "p-5",
}: {
  mensagem: string;
  consulta: { refetch: () => Promise<unknown>; isFetching: boolean; isError: boolean };
  className?: string;
}) {
  return (
    <div role="alert" className={`flex flex-col items-center gap-3 text-center ${className}`}>
      <p className="text-sm text-vermelho">{mensagem}</p>
      <TentarDeNovo tentar={() => consulta.refetch()} tentando={consulta.isFetching} falhou={consulta.isError} />
    </div>
  );
}
