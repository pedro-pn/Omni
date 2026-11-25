/** Módulos que a Administração libera aos poucos (migration 0071; Administração → Módulos). */
export const MODULOS = ["whatsapp", "emails", "missoes", "tarefas", "chamadas", "revisao"] as const;
export type Modulo = (typeof MODULOS)[number];

export const NOME_DO_MODULO: Record<Modulo, string> = {
  whatsapp: "WhatsApp",
  emails: "E-mail",
  missoes: "Missões",
  tarefas: "Tarefas",
  chamadas: "Chamadas",
  revisao: "Revisão semanal",
};

export const DESCRICAO_DO_MODULO: Record<Modulo, string> = {
  whatsapp: "Conversas do WhatsApp do próprio número (conectar, histórico, responder).",
  emails: "A própria caixa de e-mail e os e-mails na caixa única.",
  missoes: "Lista de missões, canais Interno e Gerencial e as abas da missão.",
  tarefas: "Tarefas, projetos e o que veio do Foco.",
  chamadas: "Ligações pelo WhatsApp, gravações e resumos.",
  revisao: "Revisão semanal (além disso, só gerentes e diretoria veem).",
};
