import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { PonteDeAcoes } from './acoes.mjs';

const TOKEN = 'x'.repeat(40);

function sessao(telefone) {
  const ev = new EventEmitter();
  const chamadas = [];
  const chaves = {};
  const sock = {
    ws: { isOpen: true },
    ev,
    authState: { creds: { me: { id: `${telefone}:12@s.whatsapp.net` } }, keys: { set: async (v) => Object.assign(chaves, v) } },
    resyncAppState: async (colecoes, inicial) => {
      chamadas.push(['resync', colecoes, inicial]);
      // O snapshot da agenda: um salvo, um removido e um "nome" que é só o número.
      ev.emit('contacts.upsert', [
        { id: '5547900000011@s.whatsapp.net', name: 'Ana Campo', phoneNumber: '5547900000011@s.whatsapp.net' },
        { id: '5547900000012@s.whatsapp.net', name: '+55 47 90000-0012' },
      ]);
    },
    addOrEditContact: async (jid, c) => chamadas.push(['contato', jid, c]),
    chatModify: async (m, jid) => chamadas.push(['modify', m, jid]),
    sendMessage: async (jid, m) => chamadas.push(['send', jid, m]),
  };
  return { sock, chamadas, chaves, ev };
}

test('agenda: só o nome salvo (name), não o de perfil (notify); a primeira leitura baixa a coleção de novo', async () => {
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false });
  const s = sessao('5547900000001');
  p.attach(s.sock);
  s.ev.emit('contacts.update', [{ id: '5547900000099@s.whatsapp.net', notify: 'Só perfil' }]);
  const r = await p.executar({ telefone: '5547900000001', acao: 'contatos' });
  assert.deepEqual(r.contatos, [{ jid: '5547900000011@s.whatsapp.net', lid: null, telefone: '5547900000011@s.whatsapp.net', nome: 'Ana Campo' }]);
  assert.deepEqual(s.chaves, { 'app-state-sync-version': { critical_unblock_low: null } });
  assert.deepEqual(s.chamadas[0], ['resync', ['critical_unblock_low'], true]);
  // Contato apagado no celular sai da agenda.
  s.ev.emit('contacts.upsert', [{ id: '5547900000011@s.whatsapp.net', name: undefined }]);
  assert.equal((await p.executar({ telefone: '5547900000001', acao: 'contatos' })).contatos.length, 0);
  assert.equal(s.chamadas.filter((c) => c[0] === 'resync').length, 1); // não baixa de novo
});

test('adicionar contato, fixar conversa, favoritar e fixar mensagem chamam o Baileys com os dados certos', async () => {
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false });
  const s = sessao('5547900000001');
  p.attach(s.sock);
  await p.executar({ telefone: '+55 (47) 90000-0001', acao: 'contato', jid: '5547900000077@s.whatsapp.net', nome: 'Bruno Silva' });
  await p.executar({ telefone: '5547900000001', acao: 'fixar-conversa', jid: '120363000000000001@g.us', fixar: true });
  await p.executar({ telefone: '5547900000001', acao: 'favoritar', jid: '5547900000077@s.whatsapp.net', id: 'ABC123', fromMe: false, favorita: true });
  await p.executar({ telefone: '5547900000001', acao: 'fixar-mensagem', jid: '120363000000000001@g.us', id: 'ABC124', fromMe: false, participante: '5547900000011@s.whatsapp.net', fixar: true });
  assert.deepEqual(s.chamadas[0], ['contato', '5547900000077@s.whatsapp.net', { fullName: 'Bruno Silva', firstName: 'Bruno', saveOnPrimaryAddressbook: true, pnJid: '5547900000077@s.whatsapp.net' }]);
  assert.deepEqual(s.chamadas[1], ['modify', { pin: true }, '120363000000000001@g.us']);
  assert.deepEqual(s.chamadas[2], ['modify', { star: { messages: [{ id: 'ABC123', fromMe: false }], star: true } }, '5547900000077@s.whatsapp.net']);
  assert.equal(s.chamadas[3][0], 'send');
  assert.deepEqual(s.chamadas[3][2].pin, { remoteJid: '120363000000000001@g.us', fromMe: false, id: 'ABC124', participant: '5547900000011@s.whatsapp.net' });
  assert.equal(s.chamadas[3][2].type, 1);
});

test('recusa: linha de outro número, JID inválido, ação desconhecida; e a configuração exige token longo', async () => {
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false });
  p.attach(sessao('5547900000001').sock);
  await assert.rejects(p.executar({ telefone: '5547900000002', acao: 'contatos' }), /linha_indisponivel/);
  await assert.rejects(p.executar({ telefone: '5547900000001', acao: 'contato', jid: 'x@broadcast', nome: 'A' }), /dados_invalidos/);
  await assert.rejects(p.executar({ telefone: '5547900000001', acao: 'apagar-tudo' }), /acao_desconhecida/);
  assert.throws(() => new PonteDeAcoes({ token: 'curto', escutar: false }), /invalid_acoes_config/);
});

test('HTTP: só POST /v1/acoes com o token, o Host esperado e sem Origin', async () => {
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false, hostname: 'evolution', port: 8099 });
  const req = (h) => ({ method: 'POST', url: '/v1/acoes', headers: { host: 'evolution:8099', authorization: `Bearer ${TOKEN}`, ...h } });
  assert.equal(p.autorizado(req({})), true);
  assert.equal(p.autorizado(req({ authorization: 'Bearer errado' })), false);
  assert.equal(p.autorizado(req({ origin: 'https://site.invalid' })), false);
  assert.equal(p.autorizado(req({ host: 'outro:8099' })), false);
  assert.equal(p.autorizado({ ...req({}), method: 'GET' }), false);
});
