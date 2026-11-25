/**
 * Para onde voltar depois do login. Só caminhos do próprio Omni: começa com
 * uma barra, não é "//host" nem "/\host" (que o navegador trata como outro
 * site), sem caracteres de controle. Qualquer outra coisa volta para "/".
 */
export function caminhoDeVolta(valor: unknown): string {
  if (typeof valor !== "string" || valor.length > 2000) return "/";
  if (!valor.startsWith("/") || valor.startsWith("//") || valor.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(valor)) return "/";
  return valor;
}
