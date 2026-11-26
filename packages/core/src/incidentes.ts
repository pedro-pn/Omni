/**
 * Registro de incidentes (E21, pilar 12.4; migration 0086). Regras puras do que o registro exige:
 * resolvido precisa da hora em que voltou ao normal; encerrado precisa da causa e do que muda para
 * não repetir; com dado pessoal, também dos titulares afetados e das comunicações feitas. O banco
 * confere o mesmo (CHECK); aqui a tela avisa antes.
 */

export const TIPOS_INCIDENTE = {
  indisponibilidade: "Indisponibilidade",
  dados: "Dados (vazamento, perda, acesso indevido)",
  seguranca: "Segurança (segredo, conta, invasão)",
  integracao: "Integração (filtroAPP, Prisma, Microsoft, WhatsApp)",
  erro: "Erro do sistema",
  outro: "Outro",
} as const;
export type TipoIncidente = keyof typeof TIPOS_INCIDENTE;

export const GRAVIDADES_INCIDENTE = { baixa: "Baixa", media: "Média", alta: "Alta" } as const;
export type GravidadeIncidente = keyof typeof GRAVIDADES_INCIDENTE;

export const SITUACOES_INCIDENTE = { aberto: "Aberto", resolvido: "Resolvido", encerrado: "Encerrado" } as const;
export type SituacaoIncidente = keyof typeof SITUACOES_INCIDENTE;

export type IncidenteParaConferir = {
  status: SituacaoIncidente;
  inicio: string;
  conhecidoEm: string;
  resolvidoEm: string | null;
  dadosPessoais: boolean;
  titulares: string | null;
  causa: string | null;
  correcao: string | null;
  comunicacoes: string | null;
};

const preenchido = (v: string | null | undefined) => (v ?? "").trim().length >= 3;

/** O que falta para o incidente poder ficar na situação pedida (lista vazia = pode). */
export function faltasDoIncidente(i: IncidenteParaConferir): string[] {
  const faltas: string[] = [];
  const inicio = Date.parse(i.inicio);
  if (Date.parse(i.conhecidoEm) < inicio) faltas.push("A hora em que soubemos não pode ser antes do início.");
  if (i.resolvidoEm && Date.parse(i.resolvidoEm) < inicio) faltas.push("A hora da solução não pode ser antes do início.");
  if (i.status === "aberto") return faltas;
  if (!i.resolvidoEm) faltas.push("Informe quando voltou ao normal.");
  if (i.status === "encerrado") {
    if (!preenchido(i.causa)) faltas.push("Escreva a causa.");
    if (!preenchido(i.correcao)) faltas.push("Escreva o que muda para não repetir.");
    if (i.dadosPessoais) {
      if (!preenchido(i.titulares)) faltas.push("Diga que dados e de quem (categorias, sem nomes).");
      if (!preenchido(i.comunicacoes)) faltas.push("Registre as comunicações (ou por que não foram necessárias).");
    }
  }
  return faltas;
}

/** Com dado pessoal, o prazo para avisar a ANPD e os titulares conta em dias úteis desde que soubemos. */
export const PRAZO_COMUNICACAO_DIAS_UTEIS = 3;
