// Depois do build: todo CSS (/assets/*.css) que o servidor põe na página tem de existir no que é publicado.
// Já aconteceu de o build do servidor gerar o CSS com outro nome (outro conteúdo) e a página
// abrir sem estilo até o JavaScript carregar. Falha o build (e o deploy) se acontecer de novo.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const raiz = new URL("../.output/", import.meta.url).pathname;
const arquivos = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? arquivos(join(dir, n)) : [join(dir, n)]));
const citados = new Set();
for (const f of arquivos(join(raiz, "server")).filter((f) => f.endsWith(".mjs"))) {
  for (const m of readFileSync(f, "utf8").matchAll(/\/assets\/([\w.-]+\.css)/g)) citados.add(m[1]);
}
const faltam = [...citados].filter((a) => !existsSync(join(raiz, "public", "assets", a)));
if (!citados.size || faltam.length) {
  console.error(faltam.length ? `Arquivos citados pelo servidor e ausentes em .output/public/assets: ${faltam.join(", ")}` : "Nenhum /assets/ citado pelo servidor (build mudou?)");
  process.exit(1);
}
console.log(`Assets conferidos: ${citados.size} citados pelo servidor, todos publicados.`);
