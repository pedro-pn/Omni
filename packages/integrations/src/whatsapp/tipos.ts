/**
 * WhatsApp do Omni (ADR 0004): o que as telas e o worker usam, sem saber qual
 * provedor está por trás. Hoje a Evolution (pareamento por QR code); um número
 * banido pode passar para a Cloud API oficial trocando só a implementação.
 */

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

export type EstadoConexao = "conectado" | "conectando" | "desconectado" | "inexistente";

export type ConfigWebhook = { url: string; segredo: string };

export interface WhatsApp {
  /** Cria o número no provedor (sem parear), com o webhook do Omni e as configurações seguras. */
  criarNumero(instancia: string, webhook: ConfigWebhook): Promise<void>;
  /** Reaplica webhook e configurações (idempotente). */
  configurarNumero(instancia: string, webhook: ConfigWebhook): Promise<void>;
  /** QR code para parear (imagem PNG em data URL); null se já conectado. */
  qrCode(instancia: string): Promise<{ imagem: string | null; codigoPareamento: string | null; estado: EstadoConexao }>;
  /** Estado da conexão e o número do aparelho pareado. */
  estado(instancia: string): Promise<{ estado: EstadoConexao; telefone: string | null; nomePerfil: string | null }>;
  /** Desconecta o aparelho (o número continua cadastrado; pareia de novo pelo QR). */
  desconectar(instancia: string): Promise<void>;
  /** Apaga o número do provedor. */
  remover(instancia: string): Promise<void>;
  /** Envia texto para uma pessoa (número com DDI) ou grupo (JID). */
  enviarTexto(instancia: string, para: string, texto: string): Promise<{ id: string; jid: string }>;
  /** Envia um arquivo (imagem, vídeo, áudio ou documento) com legenda opcional. */
  enviarArquivo(instancia: string, para: string, arquivo: { conteudo: Buffer; mimetype: string; nome: string; legenda?: string }): Promise<{ id: string; jid: string }>;
  /** Envia uma mensagem de voz (o provedor converte para OGG/Opus, como as gravadas no celular). */
  enviarAudio(instancia: string, para: string, audio: Buffer): Promise<{ id: string; jid: string }>;
  /** Conversas que o provedor guardou (inclui as do histórico recebido no pareamento). */
  /** Lista de conversas da Evolution; `foto` é o endereço da foto no WhatsApp (vence em alguns dias). */
  conversas(instancia: string): Promise<{ jid: string; grupo: boolean; nome: string | null; foto: string | null; ultimaEm: Date | null }[]>;
  /**
   * Lista de contatos da Evolution: o nome salvo na agenda do celular (sincronizado
   * pelo WhatsApp, muitas vezes no @lid da pessoa) ou o nome do perfil, e a foto.
   */
  contatos(instancia: string): Promise<{ jid: string; nome: string | null; foto: string | null; /** O mesmo contato pelo outro identificador (@lid ↔ número), quando a Evolution sabe. */ outro: string | null }[]>;
  /**
   * Confere no WhatsApp se cada número (só dígitos, com DDI) tem conta e devolve o
   * endereço certo (o WhatsApp pode tirar o 9 de celulares antigos do Brasil).
   */
  numerosNoWhatsApp(instancia: string, numeros: string[]): Promise<{ numero: string; existe: boolean; jid: string | null }[]>;
  /** Nome e tamanho de um grupo; null se não responder a tempo. */
  infoGrupo(instancia: string, jid: string): Promise<{ nome: string | null; participantes: number | null } | null>;
  /** Mensagens guardadas no provedor, em páginas (registros no formato do provedor; ler com lerMensagemEvolution). */
  mensagens(instancia: string, filtro: { jid?: string; desde?: Date }, pagina: number, porPagina?: number): Promise<{ registros: unknown[]; paginas: number; total: number }>;
  /** Arquivo de uma mensagem com mídia (imagem, áudio, vídeo, documento). */
  midia(instancia: string, waId: string): Promise<{ conteudo: Buffer; mimetype: string; nome: string | null }>;
}
