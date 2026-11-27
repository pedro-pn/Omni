import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { PonteDeAcoes } from './acoes.mjs';

const TOKEN = 'x'.repeat(40);

// Baileys falso: o "registro cifrado" é o JSON da ação; "RUIM" no começo não decifra (como o bad decrypt).
const baileys = (colecao) => ({
  extractSyncdPatches: async () => ({ critical_unblock_low: colecao }),
  downloadExternalPatch: async () => ({ mutations: [] }),
  hkdf: async () => Buffer.alloc(160, 7),
  aesDecrypt: (buf) => {
    if (buf.toString().startsWith('RUIM')) throw new Error('bad decrypt');
    return buf;
  },
  proto: { SyncActionData: { decode: (buf) => { const o = JSON.parse(buf.toString()); return { index: Buffer.from(JSON.stringify(o.index)), value: o.value }; } } },
});
const registro = (jid, acao, chave = 'K1') => ({
  keyId: { id: Buffer.from(chave) },
  value: { blob: Buffer.concat([Buffer.from(JSON.stringify({ index: ['contact', jid], value: { contactAction: acao } })), Buffer.alloc(32)]) },
});
const ruim = () => ({ keyId: { id: Buffer.from('K1') }, value: { blob: Buffer.concat([Buffer.from('RUIM'), Buffer.alloc(32)]) } });

function sessao(telefone, { versoes = { critical_unblock_low: { version: 42 }, regular_low: { version: 9 } } } = {}) {
  const ev = new EventEmitter();
  const chamadas = [];
  const sock = {
    ws: { isOpen: true },
    ev,
    authState: {
      creds: { me: { id: `${telefone}:12@s.whatsapp.net` } },
      keys: {
        set: async () => {},
        get: async (tipo, ids) =>
          Object.fromEntries(ids.map((i) => [i, tipo === 'app-state-sync-version' ? (versoes[i] ?? null) : tipo === 'app-state-sync-key' && i === Buffer.from('K1').toString('base64') ? { keyData: Buffer.alloc(32, 1) } : undefined])),
      },
    },
    query: async (no) => (chamadas.push(['query', no.content[0].content[0].attrs]), {}),
    resyncAppState: async (colecoes, inicial) => chamadas.push(['resync', colecoes, inicial]),
    addOrEditContact: async (jid, c) => chamadas.push(['contato', jid, c]),
    chatModify: async (m, jid) => chamadas.push(['modify', m, jid]),
    sendMessage: async (jid, m) => chamadas.push(['send', jid, m]),
  };
  return { sock, chamadas, ev };
}

test('agenda lida do servidor sem mexer no estado: registro que não abre é pulado, os outros valem; REMOVE tira', async () => {
  const colecao = {
    snapshot: {
      version: { version: 48 },
      records: [
        registro('5547900000011@s.whatsapp.net', { fullName: 'Ana Campo', lidJid: '222222222222222@lid' }),
        ruim(),
        registro('5547900000012@s.whatsapp.net', { fullName: '+55 47 90000-0012' }), // "nome" que é só o número
        registro('5547900000013@s.whatsapp.net', { fullName: 'Caio Removido' }),
        registro('5547900000014@s.whatsapp.net', { fullName: 'Sem Chave' }, 'K9'),
        registro('120363000000000001@g.us', { fullName: 'Grupo' }),
      ],
    },
    patches: [{ version: { version: 49 }, mutations: [{ operation: 1, record: registro('5547900000013@s.whatsapp.net', { fullName: 'Caio Removido' }) }] }],
    hasMorePatches: false,
  };
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false, baileys: baileys(colecao) });
  const s = sessao('5547900000001');
  p.attach(s.sock);
  const r = await p.executar({ telefone: '5547900000001', acao: 'contatos' });
  assert.deepEqual(r.contatos, [{ jid: '5547900000011@s.whatsapp.net', lid: '222222222222222@lid', telefone: '5547900000011@s.whatsapp.net', nome: 'Ana Campo' }]);
  assert.equal(r.completa, true);
  assert.deepEqual(r.diagnostico, { versaoDaColecao: 49, registros: 7, ignorados: 1, semChave: 1, doServidor: 1, doHistorico: 0, eventosNaLeitura: 0 });
  // Pediu a coleção do zero (snapshot) e não chamou o resync do Baileys.
  assert.deepEqual(s.chamadas, [['query', { name: 'critical_unblock_low', version: '0', return_snapshot: 'true' }]]);
});

test('o histórico só acrescenta (nunca apaga) e o servidor vence; grupos não entram; sem servidor, a lista do histórico é completa só se houve histórico', async () => {
  const colecao = { snapshot: { version: { version: 3 }, records: [registro('5547900000011@s.whatsapp.net', { fullName: 'Ana Campo' })] }, patches: [], hasMorePatches: false };
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false, baileys: baileys(colecao) });
  const s = sessao('5547900000001');
  p.attach(s.sock);
  s.ev.emit('messaging-history.set', {
    contacts: [
      { id: '5547900000011@s.whatsapp.net', name: 'Ana (histórico)' },
      { id: '5547900000016@s.whatsapp.net', name: 'Eva Salva' },
      { id: '5547900000016@s.whatsapp.net', name: undefined }, // conversa sem nome no histórico: não apaga
      { id: '120363000000000001@g.us', name: 'Obra Fictícia' },
    ],
  });
  s.ev.emit('contacts.upsert', [{ id: '5547900000017@s.whatsapp.net', name: 'Fábio' }, { id: '5547900000017@s.whatsapp.net', name: undefined }]); // a agenda apaga
  const r = await p.executar({ telefone: '5547900000001', acao: 'contatos' });
  assert.deepEqual(r.contatos.map((c) => c.nome).sort(), ['Ana Campo', 'Eva Salva']);

  const falha = new PonteDeAcoes({ token: TOKEN, escutar: false, baileys: { ...baileys(colecao), extractSyncdPatches: async () => { throw new Error('timed out\n at x'); } } });
  const s2 = sessao('5547900000001');
  falha.attach(s2.sock);
  const r2 = await falha.executar({ telefone: '5547900000001', acao: 'contatos' });
  assert.equal(r2.completa, false);
  assert.deepEqual(r2.mensagens, ['leitura: timed out']);
  s2.ev.emit('messaging-history.set', { contacts: [{ id: '5547900000016@s.whatsapp.net', name: 'Eva Salva' }] });
  assert.equal((await falha.executar({ telefone: '5547900000001', acao: 'contatos' })).completa, true);
});

test('alterar o app state só com a coleção sincronizada (senão o Baileys manda na versão 0 e pode corromper o servidor)', async () => {
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false, baileys: baileys({}) });
  const s = sessao('5547900000001', { versoes: { critical_unblock_low: null, regular_low: { version: 0 } } });
  p.attach(s.sock);
  await assert.rejects(p.executar({ telefone: '5547900000001', acao: 'contato', jid: '5547900000077@s.whatsapp.net', nome: 'Bruno' }), /colecao_fora_de_sincronia/);
  await assert.rejects(p.executar({ telefone: '5547900000001', acao: 'fixar-conversa', jid: '120363000000000001@g.us', fixar: true }), /colecao_fora_de_sincronia/);
  await assert.rejects(p.executar({ telefone: '5547900000001', acao: 'favoritar', jid: '5547900000077@s.whatsapp.net', id: 'ABC123', favorita: true }), /colecao_fora_de_sincronia/);
  assert.equal(s.chamadas.filter((c) => c[0] === 'contato' || c[0] === 'modify').length, 0);
  // Tentou sincronizar antes de recusar.
  assert.deepEqual(s.chamadas.filter((c) => c[0] === 'resync').map((c) => c[1][0]), ['critical_unblock_low', 'regular_low', 'regular_low']);
});

test('adicionar contato, fixar conversa, favoritar e fixar mensagem chamam o Baileys com os dados certos', async () => {
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false });
  const s = sessao('5547900000001');
  p.attach(s.sock);
  await p.executar({ telefone: '+55 (47) 90000-0001', acao: 'contato', jid: '5547900000077@s.whatsapp.net', nome: 'Bruno Silva' });
  await p.executar({ telefone: '5547900000001', acao: 'fixar-conversa', jid: '120363000000000001@g.us', fixar: true });
  await p.executar({ telefone: '5547900000001', acao: 'favoritar', jid: '5547900000077@s.whatsapp.net', id: 'ABC123', fromMe: false, favorita: true });
  await p.executar({ telefone: '5547900000001', acao: 'fixar-mensagem', jid: '120363000000000001@g.us', id: 'ABC124', fromMe: false, participante: '5547900000011@s.whatsapp.net', fixar: true });
  const a = s.chamadas.filter((c) => c[0] !== 'resync');
  assert.deepEqual(a[0], ['contato', '5547900000077@s.whatsapp.net', { fullName: 'Bruno Silva', firstName: 'Bruno', saveOnPrimaryAddressbook: true, pnJid: '5547900000077@s.whatsapp.net' }]);
  assert.deepEqual(a[1], ['modify', { pin: true }, '120363000000000001@g.us']);
  assert.deepEqual(a[2], ['modify', { star: { messages: [{ id: 'ABC123', fromMe: false }], star: true } }, '5547900000077@s.whatsapp.net']);
  assert.equal(a[3][0], 'send');
  assert.deepEqual(a[3][2].pin, { remoteJid: '120363000000000001@g.us', fromMe: false, id: 'ABC124', participant: '5547900000011@s.whatsapp.net' });
  assert.equal(a[3][2].type, 1);
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

test('lids: o telefone de cada @lid pelo mapeamento da sessão e o meu @lid; nada além de @lid', async () => {
  const p = new PonteDeAcoes({ token: TOKEN, escutar: false });
  const s = sessao('5547900000001');
  s.sock.authState.creds.me.lid = '111111111111111:12@lid';
  s.sock.signalRepository = { lidMapping: { getPNForLID: async (lid) => (lid === '222222222222222@lid' ? '5547900000011:0@s.whatsapp.net' : null) } };
  p.attach(s.sock);
  const r = await p.executar({ telefone: '5547900000001', acao: 'lids', lids: ['222222222222222@lid', '333333333333333@lid', '5547900000012@s.whatsapp.net'] });
  assert.deepEqual(r, { mapa: { '222222222222222@lid': '5547900000011', '333333333333333@lid': null }, eu: '111111111111111@lid' });
  await assert.rejects(p.executar({ telefone: '5547900000001', acao: 'lids', lids: 'x' }), /dados_invalidos/);
});
