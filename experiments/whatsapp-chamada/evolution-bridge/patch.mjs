import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || '/evolution/node_modules/baileys/lib';
const patches = [
  ['Socket/index.js', '295a516071cae724d39d46fc2237a9514f825cf01ba06558c6909d9d17595bf2',
    'return makeCommunitiesSocket(newConfig);', 'return attachCalls(makeCommunitiesSocket(newConfig));', 'attachCalls'],
  ['Socket/messages-recv.js', '8b9329ddf95fa7a1785826d8861af236f5f055ff22a5ed1ce52afdf9565d873e',
    "ws.on('CB:call', async (node) => {", "ws.on('CB:call', async (node) => {\n        if (await forwardCall(sock, node)) return;", 'forwardCall'],
];
// Validar TODOS os hashes antes de escrever qualquer arquivo.
const changes = patches.map(([name, hash, before, after, fn]) => {
  const path = join(root, name);
  const source = readFileSync(path, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== hash || source.split(before).length !== 2) throw new Error('Unexpected Baileys source: ' + name);
  return [path, `import { ${fn} } from '../omni-chamada/install.mjs';\n` + source.replace(before, after)];
});
for (const [path, source] of changes) writeFileSync(path, source);
console.log('OMNI_CALL_BRIDGE_INSTALLED_DISABLED_BY_DEFAULT');
