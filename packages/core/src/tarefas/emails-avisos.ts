/**
 * E-mails das Tarefas — porta dos modelos do Foco (`notification-digest`,
 * `weekly-overdue`, `weekly-upcoming` em `../foco/foco/src/lib/email-templates`):
 * avisos agrupados de um intervalo, atrasadas da semana (segunda, 09h) e
 * atividades da semana (segunda, 14h). Funções puras: assunto, texto e HTML.
 */

export type EmailMontado = { assunto: string; texto: string; html: string };

export type ItemAvisoEmail = { titulo: string; corpo: string; tarefaId: string | null };
export type TarefaEmail = { id: string; titulo: string; projeto: string | null; data: string; prioridade: number };

const PRIORIDADE: Record<number, string> = { 1: "P1 · Urgente", 2: "P2 · Alta", 3: "P3 · Média", 4: "P4 · Normal" };
const dataBr = (iso: string) => iso.split("-").reverse().join("/");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const linkTarefa = (app: string, id: string | null) => (id ? `${app}/?tarefa=${id}` : app);

function layout(p: { app: string; previa: string; chapeu: string; titulo: string; corpo: string; botao: { href: string; rotulo: string }; rodape: string }): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(p.titulo)}</title></head>
<body style="margin:0;background:#f3f5f3;font-family:Arial,Helvetica,sans-serif;color:#1d2a22">
<span style="display:none;max-height:0;overflow:hidden">${esc(p.previa)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f3;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#30503a;padding:18px 24px"><img src="${esc(p.app)}/marca/filtrovali-logo-horizontal-white.png" alt="Filtrovali" height="28" style="display:block;height:28px"></td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5d6b62">${esc(p.chapeu)}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${esc(p.titulo)}</h1>
${p.corpo}
<p style="margin:24px 0 0"><a href="${esc(p.botao.href)}" style="display:inline-block;background:#30503a;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${esc(p.botao.rotulo)}</a></p>
<p style="margin:24px 0 0;font-size:12px;color:#5d6b62">${esc(p.rodape)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

const paragrafo = (t: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${esc(t)}</p>`;
const item = (titulo: string, detalhe: string, href?: string) =>
  `<div style="border-top:1px solid #dde3df;padding:12px 0"><p style="margin:0 0 4px;font-size:15px;font-weight:bold">${href ? `<a href="${esc(href)}" style="color:#1d2a22;text-decoration:none">${esc(titulo)}</a>` : esc(titulo)}</p><p style="margin:0;font-size:13px;color:#5d6b62;white-space:pre-wrap">${esc(detalhe)}</p></div>`;

/** Avisos do intervalo num e-mail só (como o "notification-digest" do Foco; até 100 itens). */
export function emailDeAvisos(p: { app: string; nome: string; itens: ItemAvisoEmail[] }): EmailMontado {
  const n = p.itens.length;
  const titulo = n === 1 ? "Você tem 1 novo aviso no Omni" : `Você tem ${n} novos avisos no Omni`;
  const visiveis = p.itens.slice(0, 100);
  const corta = (s: string) => (s.length > 1200 ? `${s.slice(0, 1200)}…` : s);
  const corpo = [
    paragrafo(`Olá, ${p.nome}. Reunimos seus avisos deste intervalo em um único e-mail.`),
    ...visiveis.map((i) => item(i.titulo, corta(i.corpo), linkTarefa(p.app, i.tarefaId))),
    n > 100 ? paragrafo(`Há mais ${n - 100} avisos. Veja todos no sino do Omni.`) : "",
  ].join("");
  const texto = [
    `Olá, ${p.nome}. Reunimos seus avisos deste intervalo em um único e-mail.`,
    "",
    ...visiveis.flatMap((i) => [`• ${i.titulo}`, ...(i.corpo ? [`  ${corta(i.corpo)}`] : []), `  ${linkTarefa(p.app, i.tarefaId)}`, ""]),
    n > 100 ? `Há mais ${n - 100} avisos. Veja todos no sino do Omni.` : "",
    "Ajuste o que recebe por e-mail em Notificações e app, no menu do seu perfil.",
  ].join("\n");
  return {
    assunto: `[Omni] ${n} ${n === 1 ? "novo aviso" : "novos avisos"}`,
    texto,
    html: layout({ app: p.app, previa: titulo, chapeu: "Seus avisos reunidos", titulo, corpo, botao: { href: p.app, rotulo: "Abrir o Omni" }, rodape: "Ajuste o que recebe por e-mail em Notificações e app, no menu do seu perfil." }),
  };
}

/** Segunda, 09h: atividades em atraso atribuídas à pessoa ("weekly-overdue" do Foco). */
export function emailSemanalAtrasadas(p: { app: string; nome: string; hoje: string; tarefas: TarefaEmail[] }): EmailMontado {
  const dias = (d: string) => Math.round((Date.parse(`${p.hoje}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86_400_000);
  const ordenadas = [...p.tarefas].sort((a, b) => a.data.localeCompare(b.data) || a.prioridade - b.prioridade || a.id.localeCompare(b.id));
  const detalhe = (t: TarefaEmail) => `${t.projeto ?? "Caixa pessoal"} · Vencimento: ${dataBr(t.data)} · ${dias(t.data)} dia(s) em atraso`;
  const abertura = `Em ${dataBr(p.hoje)}, você tem ${p.tarefas.length} atividade(s) pendente(s) com data vencida. Esta lista contém somente atividades atribuídas a você.`;
  const rodape = "Resumo enviado às segundas-feiras, às 09h, no horário de Brasília. Atividades concluídas e projetos arquivados não entram no resumo.";
  return {
    assunto: "Omni — seu resumo semanal de atividades em atraso",
    texto: [`Olá, ${p.nome}.`, abertura, "", ...ordenadas.flatMap((t) => [`• ${t.titulo}`, `  ${detalhe(t)}`, `  ${linkTarefa(p.app, t.id)}`, ""]), rodape].join("\n"),
    html: layout({
      app: p.app,
      previa: `${p.tarefas.length} atividades em atraso atribuídas a você`,
      chapeu: "Resumo semanal",
      titulo: "Suas atividades em atraso",
      corpo: paragrafo(`Olá, ${p.nome}.`) + paragrafo(abertura) + ordenadas.map((t) => item(t.titulo, detalhe(t), linkTarefa(p.app, t.id))).join(""),
      botao: { href: p.app, rotulo: "Revisar minhas atividades no Omni" },
      rodape,
    }),
  };
}

/** Segunda, 14h: atividades previstas de segunda a domingo ("weekly-upcoming" do Foco). */
export function emailSemanalDaSemana(p: { app: string; nome: string; inicio: string; fim: string; tarefas: TarefaEmail[] }): EmailMontado {
  const ordenadas = [...p.tarefas].sort((a, b) => a.prioridade - b.prioridade || a.data.localeCompare(b.data) || a.id.localeCompare(b.id));
  const detalhe = (t: TarefaEmail) => `${PRIORIDADE[t.prioridade] ?? PRIORIDADE[4]} · Data: ${dataBr(t.data)} · ${t.projeto ?? "Caixa pessoal"}`;
  const abertura = `Você tem ${p.tarefas.length} atividade(s) pendente(s) prevista(s) de ${dataBr(p.inicio)} a ${dataBr(p.fim)}. A lista está ordenada da maior para a menor prioridade e, dentro de cada prioridade, pela data.`;
  const rodape = "Enviado às segundas-feiras, às 14h, no horário de Brasília. Inclui somente atividades atribuídas a você, de segunda a domingo. Atividades concluídas e projetos arquivados não entram no resumo.";
  return {
    assunto: "Omni — suas atividades previstas para esta semana",
    texto: [`Olá, ${p.nome}.`, abertura, "", ...ordenadas.flatMap((t) => [`• ${t.titulo}`, `  ${detalhe(t)}`, `  ${linkTarefa(p.app, t.id)}`, ""]), rodape].join("\n"),
    html: layout({
      app: p.app,
      previa: `${p.tarefas.length} atividades previstas para esta semana`,
      chapeu: "Planejamento semanal",
      titulo: "Suas atividades da semana",
      corpo: paragrafo(`Olá, ${p.nome}.`) + paragrafo(abertura) + ordenadas.map((t) => item(t.titulo, detalhe(t), linkTarefa(p.app, t.id))).join(""),
      botao: { href: p.app, rotulo: "Ver minhas atividades no Omni" },
      rodape,
    }),
  };
}

/** Que preferência de e-mail cobre cada tipo de aviso (null: esse tipo não vai por e-mail). */
export function preferenciaDoAviso(tipo: string): "lembretes" | "atribuicoes" | "mencoes" | "comentarios" | "concluidas" | null {
  switch (tipo) {
    case "tarefa_lembrete":
      return "lembretes";
    case "tarefa_atribuida":
      return "atribuicoes";
    case "tarefa_mencao":
      return "mencoes";
    case "tarefa_comentario":
    case "tarefa_reacao":
      return "comentarios";
    case "tarefa_concluida":
      return "concluidas";
    default:
      return null;
  }
}
