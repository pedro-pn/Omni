/**
 * Erro escrito para a pessoa ler na tela. Só esses (e as mensagens de
 * validação dos formulários) chegam ao navegador; qualquer outro erro de uma
 * server function vira uma mensagem genérica (ver src/start.ts), para nunca
 * vazar consulta, parâmetros ou detalhes do banco.
 */
export class ErroParaTela extends Error {}
