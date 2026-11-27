// Só dentro da imagem (build do Dockerfile.chamadas), com o Baileys de verdade: o Baileys cifra um contactAction (encodeSyncdPatch) e a ponte decifra pela leitura só de leitura.
import assert from 'node:assert/strict';
const U = await import('../Utils/index.js');
const { proto } = await import('../../WAProto/index.js');
const { PonteDeAcoes } = await import('./acoes.mjs');
const keyId = Buffer.from('AAAAAAAB', 'base64').toString('base64');
const keyData = Buffer.alloc(32, 5);
const getKey = async (id) => (id === keyId ? { keyData } : undefined);
const patchDe = (jid, nome, op) => U.encodeSyncdPatch({ syncAction: { contactAction: { fullName: nome, firstName: nome.split(' ')[0] } }, index: ['contact', jid], type: 'critical_unblock_low', apiVersion: 2, operation: op }, keyId, U.newLTHashState(), getKey);
const a = await patchDe('5547900000011@s.whatsapp.net', 'Ana Campo', proto.SyncdMutation.SyncdOperation.SET);
const b = await patchDe('5547900000012@s.whatsapp.net', 'Bia Obra', proto.SyncdMutation.SyncdOperation.SET);
const rec = (x) => x.patch.mutations[0].record;
// Registro estragado: mesmo id de chave, conteúdo trocado.
const estragado = proto.SyncdRecord.fromObject({ ...rec(b), value: { blob: Buffer.concat([Buffer.alloc(48, 9), Buffer.alloc(32)]) } });
const sock = {
  ws: { isOpen: true }, ev: { on() {} },
  authState: { creds: { me: { id: '5547900000001:3@s.whatsapp.net' } }, keys: { get: async (t, ids) => Object.fromEntries(ids.map((i) => [i, t === 'app-state-sync-key' && i === keyId ? proto.Message.AppStateSyncKeyData.create({ keyData }) : undefined])) } },
  query: async () => ({}),
};
const B = { extractSyncdPatches: async () => ({ critical_unblock_low: { snapshot: { version: { version: 7 }, records: [rec(a), estragado, rec(b)] }, patches: [], hasMorePatches: false } }), downloadExternalPatch: U.downloadExternalPatch, aesDecrypt: U.aesDecrypt, hkdf: U.hkdf, proto };
const p = new PonteDeAcoes({ token: 'x'.repeat(40), escutar: false, baileys: B });
p.attach(sock);
const r = await p.executar({ telefone: '5547900000001', acao: 'contatos' });
assert.deepEqual(r.contatos.map((c) => c.nome).sort(), ['Ana Campo', 'Bia Obra']);
assert.equal(r.diagnostico.ignorados, 1);
// Chave como a Evolution 2.3.7 grava (keyData em texto base64, sem o patch da imagem): também abre.
const sockTexto = { ...sock, authState: { ...sock.authState, keys: { get: async (t, ids) => Object.fromEntries(ids.map((i) => [i, t === 'app-state-sync-key' && i === keyId ? { keyData: keyData.toString('base64') } : undefined])) } } };
const p3 = new PonteDeAcoes({ token: 'x'.repeat(40), escutar: false, baileys: B });
p3.attach(sockTexto);
assert.equal((await p3.executar({ telefone: '5547900000001', acao: 'contatos' })).contatos.length, 2);
// E o carregamento padrão (sem injeção) acha as peças do Baileys da imagem.
const p2 = new PonteDeAcoes({ token: 'x'.repeat(40), escutar: false });
const pecas = await p2.baileys();
assert.equal(typeof pecas.extractSyncdPatches, 'function'); assert.equal(typeof pecas.hkdf, 'function'); assert.equal(typeof pecas.proto.SyncActionData.decode, 'function');
console.log('IDA_E_VOLTA_OK', JSON.stringify(r.diagnostico));
