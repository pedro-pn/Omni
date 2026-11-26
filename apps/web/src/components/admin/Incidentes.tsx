import { faltasDoIncidente, GRAVIDADES_INCIDENTE, SITUACOES_INCIDENTE, TIPOS_INCIDENTE } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Pencil, Plus, ShieldAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import { incidentes, salvarIncidente, type IncidenteNaTela, type IncidenteParaSalvar } from "../../lib/incidentes-fns.ts";
import { Aviso, botaoPrimario, botaoSecundario, campo, mensagemDeErro } from "./ui.tsx";

const quando = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
    : "—";

/** ISO → valor do <input type="datetime-local"> no horário de Brasília (sem horário de verão desde 2019). */
const paraCampo = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 16).replace(" ", "T") : "";
const doCampo = (v: string) => (v ? `${v}:00-03:00` : null);

type Form = Omit<IncidenteParaSalvar, "inicio" | "conhecidoEm" | "resolvidoEm"> & { inicio: string; conhecidoEm: string; resolvidoEm: string };

const vazio = (): Form => {
  const agora = paraCampo(new Date().toISOString());
  return {
    titulo: "",
    tipo: "erro",
    gravidade: "media",
    status: "aberto",
    inicio: agora,
    conhecidoEm: agora,
    resolvidoEm: "",
    oQueAconteceu: "",
    impacto: "",
    dadosPessoais: false,
    titulares: "",
    acoes: "",
    causa: "",
    correcao: "",
    comunicacoes: "",
    referencias: "",
  };
};

const doIncidente = (i: IncidenteNaTela): Form => ({
  id: i.id,
  titulo: i.titulo,
  tipo: i.tipo,
  gravidade: i.gravidade,
  status: i.status,
  inicio: paraCampo(i.inicio),
  conhecidoEm: paraCampo(i.conhecidoEm),
  resolvidoEm: paraCampo(i.resolvidoEm),
  oQueAconteceu: i.oQueAconteceu,
  impacto: i.impacto ?? "",
  dadosPessoais: i.dadosPessoais,
  titulares: i.titulares ?? "",
  acoes: i.acoes ?? "",
  causa: i.causa ?? "",
  correcao: i.correcao ?? "",
  comunicacoes: i.comunicacoes ?? "",
  referencias: i.referencias ?? "",
});

function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{rotulo}</span>
      {dica && <span className="block text-xs text-muted">{dica}</span>}
      {children}
    </label>
  );
}

function Formulario({ inicial, aoFechar }: { inicial: Form; aoFechar: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(inicial);
  const muda = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const salvar = useMutation({
    mutationFn: () =>
      salvarIncidente({
        data: { ...f, inicio: doCampo(f.inicio) ?? "", conhecidoEm: doCampo(f.conhecidoEm) ?? "", resolvidoEm: doCampo(f.resolvidoEm) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "incidentes"] });
      aoFechar();
    },
  });
  const faltas =
    f.inicio && f.conhecidoEm
      ? faltasDoIncidente({
          ...f,
          inicio: doCampo(f.inicio)!,
          conhecidoEm: doCampo(f.conhecidoEm)!,
          resolvidoEm: doCampo(f.resolvidoEm),
        })
      : ["Informe o início e quando soubemos."];
  const area = `${campo} w-full`;
  return (
    <form
      className="space-y-4 rounded-lg border border-linha bg-superficie p-4"
      onSubmit={(e) => {
        e.preventDefault();
        salvar.mutate();
      }}
    >
      <h2 className="font-medium">{f.id ? "Editar incidente" : "Registrar incidente"}</h2>
      <Campo rotulo="Título">
        <input className={area} value={f.titulo} onChange={(e) => muda("titulo", e.target.value)} maxLength={160} required />
      </Campo>
      <div className="grid gap-4 sm:grid-cols-3">
        <Campo rotulo="Tipo">
          <select className={area} value={f.tipo} onChange={(e) => muda("tipo", e.target.value as Form["tipo"])}>
            {Object.entries(TIPOS_INCIDENTE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Gravidade">
          <select className={area} value={f.gravidade} onChange={(e) => muda("gravidade", e.target.value as Form["gravidade"])}>
            {Object.entries(GRAVIDADES_INCIDENTE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Situação">
          <select className={area} value={f.status} onChange={(e) => muda("status", e.target.value as Form["status"])}>
            {Object.entries(SITUACOES_INCIDENTE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Campo>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Campo rotulo="Começou em" dica="Horário de Brasília">
          <input type="datetime-local" className={area} value={f.inicio} onChange={(e) => muda("inicio", e.target.value)} required />
        </Campo>
        <Campo rotulo="Soubemos em" dica="Conta o prazo de comunicação">
          <input type="datetime-local" className={area} value={f.conhecidoEm} onChange={(e) => muda("conhecidoEm", e.target.value)} required />
        </Campo>
        <Campo rotulo="Voltou ao normal em" dica="Obrigatório para resolver">
          <input type="datetime-local" className={area} value={f.resolvidoEm} onChange={(e) => muda("resolvidoEm", e.target.value)} />
        </Campo>
      </div>
      <Campo rotulo="O que aconteceu">
        <textarea className={area} rows={3} value={f.oQueAconteceu} onChange={(e) => muda("oQueAconteceu", e.target.value)} maxLength={4000} required />
      </Campo>
      <Campo rotulo="Impacto" dica="Quem foi afetado e por quanto tempo">
        <textarea className={area} rows={2} value={f.impacto ?? ""} onChange={(e) => muda("impacto", e.target.value)} maxLength={2000} />
      </Campo>
      <Campo rotulo="O que foi feito para conter">
        <textarea className={area} rows={2} value={f.acoes ?? ""} onChange={(e) => muda("acoes", e.target.value)} maxLength={4000} />
      </Campo>
      <Campo rotulo="Causa" dica="Obrigatória para encerrar: por que aconteceu, não só o sintoma">
        <textarea className={area} rows={2} value={f.causa ?? ""} onChange={(e) => muda("causa", e.target.value)} maxLength={4000} />
      </Campo>
      <Campo rotulo="O que muda para não repetir" dica="Obrigatório para encerrar: correção, teste ou trava nova">
        <textarea className={area} rows={2} value={f.correcao ?? ""} onChange={(e) => muda("correcao", e.target.value)} maxLength={4000} />
      </Campo>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.dadosPessoais} onChange={(e) => muda("dadosPessoais", e.target.checked)} />
        Envolveu dado pessoal
      </label>
      {f.dadosPessoais && (
        <div className="space-y-4 rounded-md border border-vermelho/40 p-3">
          <p className="text-sm text-muted">
            Avise o encarregado de dados (privacidade@filtrovali.com.br) já. Se houver risco aos titulares, a ANPD e os titulares são comunicados em até 3 dias
            úteis desde que soubemos (docs/producao/incidentes.md).
          </p>
          <Campo rotulo="Que dados e de quem" dica="Categorias, sem nomes: ex. telefones de contatos do WhatsApp">
            <textarea className={area} rows={2} value={f.titulares ?? ""} onChange={(e) => muda("titulares", e.target.value)} maxLength={1000} />
          </Campo>
          <Campo rotulo="Comunicações feitas" dica="A quem e quando, ou por que não foram necessárias">
            <textarea className={area} rows={2} value={f.comunicacoes ?? ""} onChange={(e) => muda("comunicacoes", e.target.value)} maxLength={2000} />
          </Campo>
        </div>
      )}
      <Campo rotulo="Referências" dica="PR, erro do sistema, documento. Sem dado pessoal">
        <input className={area} value={f.referencias ?? ""} onChange={(e) => muda("referencias", e.target.value)} maxLength={1000} />
      </Campo>
      {faltas.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-vermelho">
          {faltas.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {salvar.isError && <Aviso tipo="erro">{mensagemDeErro(salvar.error)}</Aviso>}
      <div className="flex gap-2">
        <button type="submit" className={botaoPrimario} disabled={salvar.isPending || faltas.length > 0}>
          Salvar
        </button>
        <button type="button" className={botaoSecundario} onClick={aoFechar}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function Texto({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted">{rotulo}</p>
      <p className="whitespace-pre-wrap break-words">{valor}</p>
    </div>
  );
}

/**
 * Incidentes (E21, pilar 12.4): o que deu errado, por quê e o que mudou. Só quem administra.
 * Encerrar pede causa e correção; com dado pessoal, também titulares e comunicações.
 */
export function Incidentes() {
  const q = useQuery({ queryKey: ["admin", "incidentes"], queryFn: () => incidentes() });
  const [editando, setEditando] = useState<Form | null>(null);
  if (q.isPending) return <p className="text-muted">Carregando…</p>;
  if (q.isError) return <Aviso tipo="erro">{mensagemDeErro(q.error)}</Aviso>;
  const lista = q.data;
  const abertos = lista.filter((i) => i.status !== "encerrado").length;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-linha bg-superficie p-4 text-sm">
        <p className="font-medium">Como funciona</p>
        <p className="mt-1 text-muted">
          Registre aqui todo incidente: queda, perda ou vazamento de dados, segredo exposto, integração parada, erro que afetou pessoas. Resolva quando voltar
          ao normal e encerre quando a causa e a correção estiverem escritas. O registro não se apaga e cada mudança fica no histórico. Passo a passo em
          docs/producao/incidentes.md.
        </p>
      </div>
      {editando ? (
        <Formulario key={editando.id ?? "novo"} inicial={editando} aoFechar={() => setEditando(null)} />
      ) : (
        <button type="button" className={`${botaoPrimario} flex items-center gap-1`} onClick={() => setEditando(vazio())}>
          <Plus size={16} aria-hidden /> Registrar incidente
        </button>
      )}
      {!lista.length ? (
        <p className="flex items-center gap-2 text-muted">
          <CircleCheck size={18} aria-hidden /> Nenhum incidente registrado.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">{abertos ? `${abertos} sem encerrar.` : "Todos encerrados."}</p>
          <ul className="divide-y divide-linha rounded-lg border border-linha bg-superficie">
            {lista.map((i) => (
              <li key={i.id} className="p-4">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-start gap-3">
                    <ShieldAlert size={18} aria-hidden className={`mt-0.5 ${i.status === "encerrado" ? "text-muted" : "text-vermelho"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{i.titulo}</span>
                      <span className="block text-xs text-muted">
                        {SITUACOES_INCIDENTE[i.status]} · {TIPOS_INCIDENTE[i.tipo]} · gravidade {GRAVIDADES_INCIDENTE[i.gravidade].toLowerCase()} · começou em{" "}
                        {quando(i.inicio)}
                        {i.dadosPessoais ? " · dado pessoal" : ""}
                      </span>
                    </span>
                  </summary>
                  <div className="mt-3 space-y-2 pl-7 text-sm">
                    <p className="text-xs text-muted">
                      Soubemos em {quando(i.conhecidoEm)} · voltou ao normal em {quando(i.resolvidoEm)} · registrado por {i.criadoPor ?? "—"} em {quando(i.criadoEm)}
                      {i.atualizadoPor ? ` · alterado por ${i.atualizadoPor} em ${quando(i.atualizadoEm)}` : ""}
                    </p>
                    <Texto rotulo="O que aconteceu" valor={i.oQueAconteceu} />
                    <Texto rotulo="Impacto" valor={i.impacto} />
                    <Texto rotulo="Contenção" valor={i.acoes} />
                    <Texto rotulo="Causa" valor={i.causa} />
                    <Texto rotulo="O que muda para não repetir" valor={i.correcao} />
                    <Texto rotulo="Dados e titulares" valor={i.titulares} />
                    <Texto rotulo="Comunicações" valor={i.comunicacoes} />
                    <Texto rotulo="Referências" valor={i.referencias} />
                    <button type="button" className={`${botaoSecundario} flex items-center gap-1`} onClick={() => setEditando(doIncidente(i))}>
                      <Pencil size={14} aria-hidden /> Editar
                    </button>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
