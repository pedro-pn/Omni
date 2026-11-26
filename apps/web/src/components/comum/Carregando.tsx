import { useId } from "react";

/**
 * Carregando com o símbolo da Filtrovali (porta do BrandLoading do filtroAPP): as três setas
 * giram em volta do centro parado. Os filtros separam setas e centro pela cor do próprio
 * símbolo oficial (public/marca/filtrovali-simbolo-carregando.webp).
 */

const SIMBOLO = "/marca/filtrovali-simbolo-carregando.webp";
const SETAS = [
  { nome: "azul", matriz: "0 -32 32 0 -5", x: "-0.06%", y: "-0.55%" },
  { nome: "vermelha", matriz: "8 -8 0 0 -2.5", x: "0.2%", y: "-1.4%" },
  { nome: "roxa", matriz: "8 8 0 0 -8", x: "0.17%", y: "1.25%" },
];

export function Carregando({ rotulo = "Carregando", tamanho = "md", className = "" }: { rotulo?: string; tamanho?: "sm" | "md" | "lg"; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <div role="status" aria-label={rotulo} aria-live="polite" className={`flex justify-center ${className}`}>
      <span className={`omni-carregando omni-carregando--${tamanho}`} aria-hidden="true">
        <svg className="omni-carregando__filtros" focusable="false">
          <defs>
            <filter id={`${id}-centro`} colorInterpolationFilters="sRGB">
              <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 64 -64 0 0" result="centro" />
              <feComposite in="SourceGraphic" in2="centro" operator="in" />
            </filter>
            {SETAS.map((s) => (
              <filter key={s.nome} id={`${id}-${s.nome}`} colorInterpolationFilters="sRGB">
                <feColorMatrix in="SourceGraphic" type="matrix" values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  ${s.matriz}`} result="seta" />
                <feComposite in="SourceGraphic" in2="seta" operator="in" />
              </filter>
            ))}
          </defs>
        </svg>
        <span className="omni-carregando__giro">
          {SETAS.map((s) => (
            <img key={s.nome} src={SIMBOLO} alt="" className="omni-carregando__seta" style={{ filter: `url(#${id}-${s.nome})`, transform: `translate(${s.x}, ${s.y})` }} />
          ))}
        </span>
        <img src={SIMBOLO} alt="" className="omni-carregando__centro" style={{ filter: `url(#${id}-centro) var(--omni-carregando-centro, opacity(1))` }} />
      </span>
    </div>
  );
}
