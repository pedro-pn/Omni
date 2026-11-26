import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Lock, Mail, MessageCircle, Shield, Sparkles, Video, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { linhaDoTempoDaMissao, type FonteTudo, type ItemTudo } from "../../lib/tudo-fns.ts";
import { FalhaAoCarregar } from "../comum/TentarDeNovo.tsx";
import { Carregando } from "../comum/Carregando.tsx";

/**
 * Aba "Tudo" da missão: Interno, Gerencial, WhatsApp, e-mails, reuniões e RDOs
 * numa linha do tempo, só com o que a pessoa já pode ver. Tocar num item abre a
 * aba de origem (é lá que se responde).
 */

const FONTE: Record<FonteTudo, { rotulo: string; icone: LucideIcon; cor: string; aba: string }> = {
  interno: { rotulo: "Interno", icone: Lock, cor: "text-floresta-texto", aba: "interno" },
  gerencial: { rotulo: "Gerencial", icone: Shield, cor: "text-lilas", aba: "gerencial" },
  whatsapp: { rotulo: "WhatsApp", icone: MessageCircle, cor: "text-[#1f9d55]", aba: "whatsapp" },
  email: { rotulo: "E-mail", icone: Mail, cor: "text-azul", aba: "emails" },
  reuniao: { rotulo: "Reunião", icone: Video, cor: "text-azul", aba: "reunioes" },
  rdo: { rotulo: "RDO", icone: ClipboardList, cor: "text-muted", aba: "rdos" },
};

const TZ = { timeZone: "America/Sao_Paulo" } as const;
const dia = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", ...TZ });
const hora = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...TZ });

export function TudoDaMissao({ missionId, abrirAba }: { missionId: string; abrirAba: (aba: string) => void }) {
  const q = useQuery({ queryKey: ["tudo", missionId], queryFn: () => linhaDoTempoDaMissao({ data: { missionId } }), refetchInterval: 60_000 });
  const fim = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fim.current?.scrollIntoView({ block: "end" });
  }, [q.data?.length]);
  if (q.isPending) return <Carregando className="p-5" />;
  if (q.isError) return <FalhaAoCarregar mensagem="Não foi possível carregar a linha do tempo da missão." consulta={q} />;
  if (!q.data.length) return <p className="p-5 text-sm text-muted">Nada por aqui ainda. Mensagens dos canais, do grupo do WhatsApp, e-mails e RDOs aparecem juntos nesta aba.</p>;
  let ultimoDia = "";
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-5">
      <p className="text-xs text-muted">Tudo o que você pode ver desta missão, em ordem. Toque num item para responder no lugar dele.</p>
      {q.data.map((it) => {
        const d = dia(it.em);
        const separador = d !== ultimoDia;
        ultimoDia = d;
        return (
          <div key={it.id}>
            {separador && <p className="rotulo py-2 text-center text-muted first-letter:uppercase">{d}</p>}
            <Item it={it} abrirAba={abrirAba} />
          </div>
        );
      })}
      <div ref={fim} />
    </div>
  );
}

function Item({ it, abrirAba }: { it: ItemTudo; abrirAba: (aba: string) => void }) {
  const f = FONTE[it.fonte];
  const Icone = it.tipo === "ia" ? Sparkles : f.icone;
  if (it.tipo === "sistema") {
    return (
      <button type="button" onClick={() => abrirAba(f.aba)} className="mx-auto flex max-w-full items-center gap-1.5 rounded-full bg-superficie px-3 py-1 text-xs text-muted shadow-sm hover:text-ink">
        <Icone size={13} aria-hidden className="shrink-0" />
        <span className="truncate">
          {f.rotulo} · {it.texto}
        </span>
        <span className="shrink-0">· {hora(it.em)}</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={() => abrirAba(f.aba)} className="block w-full rounded-lg border border-linha bg-superficie p-3 text-left text-sm hover:bg-superficie-2">
      <span className="flex items-center gap-1.5 text-xs">
        <Icone size={14} aria-hidden className={`shrink-0 ${f.cor}`} />
        <span className={`font-semibold ${f.cor}`}>{f.rotulo}</span>
        {it.titulo && <span className="min-w-0 truncate text-muted">· {it.titulo}</span>}
        {it.autor && <span className="min-w-0 truncate font-medium">· {it.autor}</span>}
        <span className="ml-auto shrink-0 text-muted">{hora(it.em)}</span>
      </span>
      {it.texto && <span className="mt-1 line-clamp-4 block whitespace-pre-wrap break-words">{it.texto}</span>}
    </button>
  );
}
