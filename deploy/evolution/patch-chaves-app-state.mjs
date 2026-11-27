import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Chaves do "app state" (agenda, fixar, favoritar…) gravadas pela Evolution 2.3.7: a chave chega
// como mensagem do protobuf (AppStateSyncKeyData) e, ao gravar, o JSON.stringify chama o toJSON
// do protobuf — os bytes da chave (keyData) viram texto base64. Na leitura, a Evolution recria com
// AppStateSyncKeyData.create(...), que NÃO decodifica o base64: a chave vira lixo e toda coleção
// dá "bad decrypt" depois que a Evolution reinicia (antes disso, a chave certa está no cache em
// memória). fromObject decodifica o base64 (e aceita bytes como já estão).
const raiz = process.argv[2] || '/evolution/dist';
const arquivos = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? arquivos(join(dir, n)) : [join(dir, n)]));
const PADRAO = /\b([A-Za-z_$][\w$]*)\.Message\.AppStateSyncKeyData\.create\(/g;
let total = 0;
let noMain = 0;
for (const f of arquivos(raiz).filter((f) => /\.(m?js)$/.test(f))) {
  const s = readFileSync(f, 'utf8');
  const n = (s.match(PADRAO) ?? []).length;
  if (!n) continue;
  writeFileSync(f, s.replace(PADRAO, '$1.Message.AppStateSyncKeyData.fromObject('));
  total += n;
  if (f.endsWith('/main.mjs')) noMain = n;
}
// main.mjs (o que a Evolution roda) tem os três gravadores de sessão: Redis, Prisma e arquivo.
if (noMain !== 3) throw new Error(`Esperava 3 leituras de chave em main.mjs, achei ${noMain}; revise antes de aplicar`);
console.log(`EVOLUTION_APP_STATE_KEYS_FIXED ${total}`);
