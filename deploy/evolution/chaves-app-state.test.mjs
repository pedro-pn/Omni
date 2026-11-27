// Na imagem: a chave do app state sobrevive à ida e volta pelo JSON (como a Evolution grava no Redis).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { proto } = await import('/evolution/node_modules/baileys/WAProto/index.js');
const original = proto.Message.AppStateSyncKeyData.fromObject({
  keyData: Buffer.alloc(32, 7),
  fingerprint: { rawId: 1, currentIndex: 2, deviceIndexes: [0, 3] },
  timestamp: 1764200000000,
});
// O que a Evolution grava: JSON.stringify (toJSON do protobuf: bytes viram base64) — duas vezes.
const gravado = JSON.parse(JSON.parse(JSON.stringify(JSON.stringify(original))));
assert.equal(typeof gravado.keyData, 'string', 'gravado como base64 (por isso o create não servia)');
assert.ok(!Buffer.from(proto.Message.AppStateSyncKeyData.create(gravado).keyData ?? []).equals(Buffer.alloc(32, 7)), 'create não decodifica');
const lido = proto.Message.AppStateSyncKeyData.fromObject(gravado);
assert.ok(Buffer.from(lido.keyData).equals(Buffer.alloc(32, 7)), 'fromObject devolve os bytes da chave');
// Com os bytes já certos (cache em memória), fromObject mantém.
assert.ok(Buffer.from(proto.Message.AppStateSyncKeyData.fromObject(original).keyData).equals(Buffer.alloc(32, 7)));
const main = readFileSync('/evolution/dist/main.mjs', 'utf8');
assert.equal((main.match(/AppStateSyncKeyData\.create\(/g) ?? []).length, 0);
assert.equal((main.match(/AppStateSyncKeyData\.fromObject\(/g) ?? []).length, 3);
console.log('APP_STATE_KEYS_TEST_OK');
