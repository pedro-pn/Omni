import { useEffect, useRef, useState } from "react";

/**
 * Listas longas (conversas, Caixa): desenha as primeiras `passo` e acrescenta mais quando a
 * pessoa rola perto do fim — montar centenas de itens de uma vez travava a troca de aba.
 * `chave` (busca, aba) volta ao começo.
 */
export function useListaProgressiva(total: number, chave: string, passo = 60) {
  const [limite, setLimite] = useState(passo);
  const sentinela = useRef<HTMLLIElement>(null);
  useEffect(() => setLimite(passo), [chave, passo]);
  useEffect(() => {
    const el = sentinela.current;
    if (!el || limite >= total || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setLimite((l) => l + passo), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [limite, total, passo]);
  return { limite, sentinela, faltam: Math.max(0, total - limite) };
}
