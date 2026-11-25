import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Executa só o fetchContacts corrigido, com sessão e banco falsos: sem rede.
const source = readFileSync(process.argv[2] || '/evolution/dist/main.mjs', 'utf8');
const start = source.indexOf('async fetchContacts({instanceName:s},e){let r=');
assert(start >= 0, 'patch não aplicado');
let i = source.indexOf('{', source.indexOf(')', start)), depth = 0;
for (; i < source.length; i++) {
  if (source[i] === '{') depth++;
  else if (source[i] === '}' && --depth === 0) break;
}
const methodSource = source.slice(start, i + 1);

const pedidos = [];
const chaves = { 5547900000001: '111111111111111', '222222222222222_reverse': '5547900000002', '333333333333333_reverse': 'lixo' };
const instancia = {
  fetchContacts: async () => [
    { remoteJid: '5547900000001@s.whatsapp.net', pushName: 'Pelo número' },
    { remoteJid: '222222222222222@lid', pushName: 'Pelo LID' },
    { remoteJid: '5547900000009@s.whatsapp.net', pushName: 'Sem mapeamento' },
    { remoteJid: '333333333333333@lid', pushName: 'Mapeamento inválido' },
    { remoteJid: '120363000000000000@g.us', pushName: 'Grupo' },
  ],
  client: {
    signalRepository: {
      lidMapping: {
        keys: { get: async (tipo, ids) => (pedidos.push([tipo, ids]), Object.fromEntries(ids.filter((k) => k in chaves).map((k) => [k, chaves[k]]))) },
        getLIDForPN: async () => assert.fail('não pode consultar a rede'),
      },
    },
  },
};
const ctrl = vm.runInNewContext(`({ ${methodSource} })`, { console, Promise }, { timeout: 1000 });
const r = await ctrl.fetchContacts.call({ waMonitor: { waInstances: { x: instancia } } }, { instanceName: 'x' }, {});
assert.equal(r[0].lidJid, '111111111111111@lid');
assert.equal(r[1].pnJid, '5547900000002@s.whatsapp.net');
assert.equal(r[2].lidJid, undefined);
assert.equal(r[3].pnJid, undefined);
assert.equal(r[4].lidJid, undefined);
assert.deepEqual(pedidos.map((p) => p[0]), ['lid-mapping', 'lid-mapping']);
// Sem sessão (desconectado): devolve a lista como veio.
const sem = await ctrl.fetchContacts.call({ waMonitor: { waInstances: { x: { fetchContacts: async () => [{ remoteJid: '1@lid' }] } } } }, { instanceName: 'x' }, {});
assert.deepEqual(sem, [{ remoteJid: '1@lid' }]);
console.log('EVOLUTION_LID_MAPPING_TEST_OK');
