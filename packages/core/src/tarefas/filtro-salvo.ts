/**
 * Filtros salvos das Tarefas — porta de `matchesFilterQuery` do Foco
 * (`../foco/foco/src/features/foco/task-app.tsx`), com a mesma linguagem:
 *
 *   `|` separa alternativas (OU) e `&` junta condições (E); `!` nega.
 *   hoje · amanha · atrasada(s) · concluida(s) · aberta(s) · sem data · 7 dias
 *   p1–p4 · @etiqueta · #projeto · +pessoa · responsavel:pessoa · projeto:nome
 *   qualquer outro texto procura no título e na descrição.
 *
 * Ex.: `hoje & p1 | atrasada & #Missão 5719`. Sem acentos nem maiúsculas.
 * Só os nomes dos campos mudaram para os do Omni; o comportamento é o do Foco.
 */

export type TarefaParaFiltro = {
  titulo: string;
  descricao: string;
  /** AAAA-MM-DD; no Omni toda tarefa tem data, mas a regra "sem data" continua valendo. */
  data: string | null;
  prioridade: number;
  etiquetas: string[];
  concluida: boolean;
  projetoNome: string | null;
  responsavelEmail: string | null;
};

export type ContextoFiltro = { hoje: string; pessoas: Array<{ nome: string; email: string }> };

export function normalizarBusca(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

function maisDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function tarefaCombinaComFiltro(tarefa: TarefaParaFiltro, consulta: string, contexto: ContextoFiltro): boolean {
  const amanha = maisDias(contexto.hoje, 1);
  const fimDaSemana = maisDias(contexto.hoje, 7);
  const concluida = tarefa.concluida;
  const grupos = consulta.split("|").map((grupo) =>
    grupo
      .split("&")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const pessoaPor = (busca: string, campo: (p: { nome: string; email: string }) => boolean) => contexto.pessoas.find(campo);
  const combina = (bruto: string) => {
    let clausula = normalizarBusca(bruto);
    let negar = false;
    while (clausula.startsWith("!")) {
      negar = !negar;
      clausula = clausula.slice(1).trim();
    }
    let resultado = true;
    if (clausula === "hoje" || clausula === "today") resultado = !concluida && tarefa.data === contexto.hoje;
    else if (clausula === "amanha" || clausula === "tomorrow") resultado = !concluida && tarefa.data === amanha;
    else if (["atrasada", "atrasadas", "overdue"].includes(clausula)) resultado = !concluida && Boolean(tarefa.data && tarefa.data < contexto.hoje);
    else if (["concluida", "concluidas", "completed"].includes(clausula)) resultado = concluida;
    else if (["aberta", "abertas", "open"].includes(clausula)) resultado = !concluida;
    else if (["sem data", "no date"].includes(clausula)) resultado = !tarefa.data;
    else if (["7 dias", "proximos 7 dias", "next 7 days"].includes(clausula))
      resultado = !concluida && Boolean(tarefa.data && tarefa.data >= contexto.hoje && tarefa.data <= fimDaSemana);
    else if (/^p[1-4]$/.test(clausula)) resultado = tarefa.prioridade === Number(clausula[1]);
    else if (clausula.startsWith("@")) resultado = tarefa.etiquetas.some((e) => normalizarBusca(e) === clausula.slice(1));
    else if (clausula.startsWith("#")) resultado = normalizarBusca(tarefa.projetoNome ?? "").includes(clausula.slice(1));
    else if (clausula.startsWith("+")) {
      const busca = clausula.slice(1);
      const pessoa = pessoaPor(busca, (p) => normalizarBusca(p.nome).includes(busca) || normalizarBusca(p.email).startsWith(busca));
      resultado = Boolean(pessoa && tarefa.responsavelEmail === pessoa.email);
    } else if (clausula.startsWith("responsavel:")) {
      const busca = clausula.slice(clausula.indexOf(":") + 1).trim();
      const pessoa = pessoaPor(busca, (p) => normalizarBusca(p.nome).includes(busca) || normalizarBusca(p.email).includes(busca));
      resultado = Boolean(pessoa && tarefa.responsavelEmail === pessoa.email);
    } else if (clausula.startsWith("projeto:")) resultado = normalizarBusca(tarefa.projetoNome ?? "").includes(clausula.slice(clausula.indexOf(":") + 1).trim());
    else resultado = normalizarBusca(`${tarefa.titulo} ${tarefa.descricao}`).includes(clausula);
    return negar ? !resultado : resultado;
  };
  return grupos.some((grupo) => grupo.every(combina));
}
