import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Executa só o "contacts.upsert" corrigido, com banco falso: sem rede nem sessão.
const source = readFileSync(process.argv[2] || '/evolution/dist/main.mjs', 'utf8');
const start = source.indexOf('"contacts.upsert":async');
assert(start >= 0);
let i = source.indexOf('{', start), depth = 0;
for (; i < source.length; i++) {
  if (source[i] === '{') depth++;
  else if (source[i] === '}' && --depth === 0) break;
}
const handlerSource = source.slice(start + '"contacts.upsert":'.length, i + 1);

const contatos = new Map([['5547900000001@s.whatsapp.net', null], ['5547900000002@s.whatsapp.net', 'Já tinha nome']]);
const self = {
  instanceId: 'inst',
  instance: { name: 'x', id: 'inst' },
  configService: { get: (k) => (k === 'DATABASE' ? { SAVE_DATA: { CONTACTS: true } } : { ENABLED: false }) },
  sendDataWebhook() {},
  profilePicture: async () => ({ profilePictureUrl: null }),
  localChatwoot: undefined,
  logger: { error() {} },
  prismaRepository: {
    contact: {
      createMany: async ({ data }) => { for (const c of data) if (!contatos.has(c.remoteJid)) contatos.set(c.remoteJid, c.pushName); },
      updateMany: async ({ where, data }) => { if ('pushName' in data && contatos.has(where.remoteJid)) contatos.set(where.remoteJid, data.pushName); },
    },
  },
};
// Arrow function: o `this` vem de quem a cria (uma função comum chamada com o objeto falso).
const handler = vm.runInNewContext(`(function () { return (${handlerSource}); })`, { Dt: async () => {}, console, Promise }, { timeout: 1000 }).call(self);
await handler([
  { id: '5547900000001@s.whatsapp.net', name: 'Cliente da Agenda' }, // existia sem nome → ganha o da agenda
  { id: '5547900000002@s.whatsapp.net', notify: 'Perfil' }, // sem nome da agenda → o do perfil
  { id: '123456789012345@lid', name: 'Pelo LID' }, // novo
  { id: '5547900000003@s.whatsapp.net' }, // sem nome nenhum → o número (comportamento original), não sobrescreve
  { id: '5547900000004@s.whatsapp.net', name: '+55 47 90000-0004' }, // "nome" que é o número → não vira nome
]);
assert.equal(contatos.get('5547900000001@s.whatsapp.net'), 'Cliente da Agenda');
assert.equal(contatos.get('5547900000002@s.whatsapp.net'), 'Perfil');
assert.equal(contatos.get('123456789012345@lid'), 'Pelo LID');
assert.equal(contatos.get('5547900000003@s.whatsapp.net'), '5547900000003');
console.log('EVOLUTION_CONTACT_NAMES_TEST_OK');
