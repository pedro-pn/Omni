import { Download, ExternalLink, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Imagem no chat (WhatsApp, canais da missão): clicar abre a prévia grande na própria tela,
 * com "Abrir em nova aba" e "Baixar". Esc, clique fora ou o X fecham; clicar na imagem
 * alterna o zoom (tamanho real, com rolagem).
 */
export function ImagemComPrevia({
  src,
  alt,
  nome,
  baixar,
  className = "",
}: {
  src: string;
  alt: string;
  /** Nome do arquivo para o download (sem nome, o navegador escolhe). */
  nome?: string | null;
  /** Endereço de download, quando é diferente do da imagem (ex.: `?baixar=1`). */
  baixar?: string;
  className?: string;
}) {
  const [aberta, setAberta] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAberta(true)} className="mb-1 block cursor-zoom-in" aria-label={`Ver a imagem ${nome ?? alt}`}>
        <img src={src} alt={alt} loading="lazy" className={className} />
      </button>
      {aberta && <PreviaDaImagem src={src} alt={alt} nome={nome ?? null} baixar={baixar ?? src} fechar={() => setAberta(false)} />}
    </>
  );
}

function PreviaDaImagem({ src, alt, nome, baixar, fechar }: { src: string; alt: string; nome: string | null; baixar: string; fechar: () => void }) {
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [fechar]);
  const botao = "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white hover:bg-white/15";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={nome ?? alt} className="fixed inset-0 z-[60] flex flex-col bg-black/90" onClick={fechar}>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <p className="min-w-0 flex-1 truncate text-sm text-white/80">{nome ?? ""}</p>
        <button type="button" className={botao} onClick={() => setZoom(!zoom)} aria-label={zoom ? "Ajustar à tela" : "Ver no tamanho real"}>
          {zoom ? <ZoomOut size={18} aria-hidden /> : <ZoomIn size={18} aria-hidden />}
        </button>
        <a href={src} target="_blank" rel="noreferrer" className={botao}>
          <ExternalLink size={18} aria-hidden /> <span className="hidden sm:inline">Abrir em nova aba</span>
        </a>
        <a href={baixar} download={nome ?? true} className={botao}>
          <Download size={18} aria-hidden /> <span className="hidden sm:inline">Baixar</span>
        </a>
        <button type="button" className={botao} onClick={fechar} aria-label="Fechar" autoFocus>
          <X size={20} aria-hidden />
        </button>
      </div>
      <div className={`min-h-0 flex-1 ${zoom ? "overflow-auto" : "flex items-center justify-center overflow-hidden"} p-3`}>
        <img
          src={src}
          alt={alt}
          onClick={(e) => {
            e.stopPropagation();
            setZoom(!zoom);
          }}
          className={zoom ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
        />
      </div>
    </div>,
    document.body,
  );
}
