import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const filename = process.argv[2] || '/evolution/node_modules/baileys/lib/Socket/socket.js';
const expected = 'd7e121951ae786d39fb729e193816515869e6ca96babf386515b54de07ef7d61';
const source = readFileSync(filename, 'utf8');
if (createHash('sha256').update(source).digest('hex') !== expected) {
  throw new Error('Unexpected Baileys source; review before applying presence fix');
}
const oldCondition = 'if (creds.me?.name !== name) {';
const newCondition = "if (typeof name === 'string' && name.length > 0 && creds.me?.name !== name) {";
if (source.split(oldCondition).length !== 2) throw new Error('Ambiguous presence handler');
writeFileSync(filename, source.replace(oldCondition, newCondition));
console.log('BAILEYS_PARTIAL_CREDENTIAL_PRESENCE_FIXED');
