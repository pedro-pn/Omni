import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { CallBridge } from './bridge.mjs';
import { encodeNode, decodeNode, canonicalPhone } from './protocol.mjs';
import { fixture, A, B, ALID, BLID, TOKEN, utils } from './fixture.mjs';
import { proto } from '../../WAProto/index.js';

test('ponte local: autenticação, sessão única, Signal compartilhado e fallback', async t => {
  const f = await fixture();
  const bridge = new CallBridge({ token: TOKEN, line: A, allowed: [B], port: 19497, utils });
  await once(bridge.http, 'listening');
  bridge.attach(f.sock);
  const url = 'ws://127.0.0.1:19497/v1/calls';
  const connect = async (headers = { Authorization: 'Bearer ' + TOKEN }) => {
    const ws = new WebSocket(url, { headers });
    await once(ws, 'open'); return ws;
  };
  t.after(() => bridge.close());
  await t.test('sem token e com Origin não abre o canal', async () => {
    for (const headers of [{}, { Authorization: 'Bearer ' + TOKEN, Origin: 'http://malicioso.invalid' }]) {
      const ws = new WebSocket(url, { headers }); ws.on('error', () => {});
      const [, response] = await once(ws, 'unexpected-response');
      assert.equal(response.statusCode, 401); ws.terminate();
    }
  });
  const ws = await connect();
  const messages = [], pending = new Map();
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } else messages.push(m);
  });
  let seq = 0, epoch;
  const rpc = (method, params = {}, selectedEpoch = epoch) => new Promise(resolve => {
    const id = String(++seq); pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, epoch: selectedEpoch }));
  });
  await t.test('snapshot só contém identidade pública e exige subscribe', async () => {
    const snapshot = (await rpc('snapshot')).result;
    assert.deepEqual(Object.keys(snapshot).sort(), ['account', 'epoch', 'id', 'lid', 'version']);
    assert.equal(snapshot.id, `${A}:3@s.whatsapp.net`);
    epoch = snapshot.epoch;
    assert.ok((await rpc('devices', { jids: [BLID] })).error);
    assert.ok((await rpc('subscribe', {}, 'antiga')).error);
    assert.deepEqual((await rpc('subscribe')).result, {});
  });
  await t.test('uma conexão e uma linha por vez', async () => {
    const other = new WebSocket(url, { headers: { Authorization: 'Bearer ' + TOKEN } }); other.on('error', () => {});
    const [, response] = await once(other, 'unexpected-response');
    assert.equal(response.statusCode, 409); other.terminate();
    assert.ok((await rpc('resolveLID', { jid: '5511987654399@s.whatsapp.net' })).error);
    assert.equal((await rpc('resolveLID', { jid: B + '@s.whatsapp.net' })).result.jid, BLID);
  });
  await t.test('criptografa a chave de chamada no Signal da Evolution, com padding uma vez', async () => {
    const plaintext = proto.Message.encode({ call: { callKey: Buffer.alloc(32, 7) } }).finish();
    const result = await rpc('encrypt', { jid: BLID, plaintext: Buffer.from(plaintext).toString('base64') });
    assert.ok(!result.error);
    const enc = decodeNode(result.result.node);
    assert.equal(enc.attrs.type, 'pkmsg'); assert.equal(result.result.identity, true);
    const padded = await f.remote.signalRepository.decryptMessage({ jid: ALID, type: enc.attrs.type, ciphertext: enc.content });
    assert.deepEqual(Buffer.from(utils.unpadRandomMax16(padded)), Buffer.from(plaintext));
    // Uma mensagem ordinária usa a MESMA sessão e não quebra o próximo passo.
    const ordinary = await f.remote.signalRepository.encryptMessage({ jid: ALID, data: utils.writeRandomPadMax16(Buffer.from('mensagem')) });
    const decoded = await f.sock.signalRepository.decryptMessage({ jid: BLID, ...ordinary });
    assert.equal(Buffer.from(utils.unpadRandomMax16(decoded)).toString(), 'mensagem');
    const reply = await f.remote.signalRepository.encryptMessage({ jid: ALID, data: utils.writeRandomPadMax16(plaintext) });
    const inbound = await rpc('decrypt', { jid: BLID, node: encodeNode({ tag: 'enc', attrs: { v: '2', type: reply.type }, content: reply.ciphertext }) });
    assert.deepEqual(Buffer.from(inbound.result.plaintext, 'base64'), Buffer.from(plaintext));
    assert.ok((await rpc('encrypt', { jid: BLID, plaintext: Buffer.from('mensagem').toString('base64') })).error);
    // iPhone: a chave chega junto de metadados de aparelhos; continua sendo só chave de chamada.
    const comMetadados = proto.Message.encode({ call: { callKey: Buffer.alloc(32, 9) }, messageContextInfo: { deviceListMetadataVersion: 2 } }).finish();
    const iphone = await f.remote.signalRepository.encryptMessage({ jid: ALID, data: utils.writeRandomPadMax16(comMetadados) });
    const aceito = await rpc('decrypt', { jid: BLID, node: encodeNode({ tag: 'enc', attrs: { v: '2', type: iphone.type }, content: iphone.ciphertext }) });
    assert.ok(!aceito.error);
    assert.deepEqual(Buffer.from(aceito.result.plaintext, 'base64'), Buffer.from(comMetadados));
    // Conversa nunca passa, nem sozinha nem junto de uma chave.
    for (const conteudo of [{ conversation: 'oi' }, { call: { callKey: Buffer.alloc(32, 1) }, conversation: 'oi' }]) {
      const cifrado = await f.remote.signalRepository.encryptMessage({ jid: ALID, data: utils.writeRandomPadMax16(proto.Message.encode(conteudo).finish()) });
      assert.ok((await rpc('decrypt', { jid: BLID, node: encodeNode({ tag: 'enc', attrs: { v: '2', type: cifrado.type }, content: cifrado.ciphertext }) })).error);
    }
  });
  await t.test('apenas chamadas individuais autorizadas são desviadas; ACK não duplica', async () => {
    const node = { tag: 'call', attrs: { from: BLID, id: 'in-1', t: '1' }, content: [
      { tag: 'offer', attrs: { 'call-id': 'call-1', 'call-creator': BLID }, content: [] },
    ] };
    const expected = once(ws, 'message');
    assert.equal(await bridge.forwardCall(f.sock, node), true);
    await expected;
    assert.equal(messages.filter(m => m.node?.attrs.id === 'in-1').length, 1);
    assert.equal(f.sent.length, 0); // ACK só será enviado pelo motor Go.
    const group = structuredClone(node); group.content[0].attrs['call-id'] = 'group-1'; group.content[0].attrs.type = 'group';
    assert.equal(await bridge.forwardCall(f.sock, group), false);
    const video = structuredClone(node); video.content[0].attrs['call-id'] = 'video-1'; video.content[0].content.push({ tag: 'video', attrs: {} });
    assert.equal(await bridge.forwardCall(f.sock, video), false);
    const stranger = structuredClone(node); stranger.attrs.from = '5511987654399@s.whatsapp.net'; stranger.content[0].attrs['call-id'] = 'unknown';
    assert.equal(await bridge.forwardCall(f.sock, stranger), false);
    assert.ok((await rpc('send', { node: encodeNode({ tag: 'message', attrs: { to: BLID } }) })).error);
    f.sock.ws.emit('frame', { tag: 'message', attrs: { id: 'ordinary' }, content: [] });
    assert.equal(messages.filter(m => m.node?.tag === 'message').length, 0);
  });
  await t.test('queda do socket invalida o gravador e mantém a sessão na Evolution', async () => {
    const closed = once(ws, 'close');
    f.sock.ev.emit('connection.update', { connection: 'close' });
    await closed;
    assert.equal(f.sock.ws.isOpen, true); // a ponte nunca chama Disconnect/Logout.
    assert.equal(await bridge.forwardCall(f.sock, { tag: 'call' }), false);
  });
});

test('formato preserva LID, bytes e distinção entre filho e conteúdo vazio', () => {
  const original = { tag: 'call', attrs: { from: BLID.replace('@', ':9@') }, content: [
    { tag: 'enc', attrs: { type: 'pkmsg', v: '2' }, content: Buffer.from([0, 255, 128]) },
    { tag: 'empty', attrs: {}, content: [] },
  ] };
  assert.deepEqual(decodeNode(encodeNode(original)), original);
  assert.equal(canonicalPhone('5511987654300'), canonicalPhone('551187654300'));
  assert.throws(() => decodeNode({ tag: 'x', attrs: {}, data: '?!' }));
  assert.throws(() => decodeNode({ tag: 'x', attrs: {}, data: '', children: [] }));
});

test('duas linhas simultâneas têm leases exclusivas e recebem somente seus eventos', async t => {
  const a = await fixture(), b = await fixture();
  b.sock.authState.creds.me = { id: `${B}:3@s.whatsapp.net`, lid: BLID.replace('@', ':3@') };
  const bridge = new CallBridge({ token: TOKEN, allowed: [A, B], multiple: true, port: 19496, utils });
  await once(bridge.http, 'listening'); bridge.attach(a.sock); bridge.attach(b.sock);
  t.after(() => bridge.close());
  const connect = async line => {
    const ws = new WebSocket('ws://127.0.0.1:19496/v1/calls', { headers: { Authorization: 'Bearer ' + TOKEN } }); await once(ws, 'open');
    const events = [], pending = new Map(); let epoch, seq = 0;
    ws.on('message', data => { const m = JSON.parse(data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } else events.push(m); });
    const rpc = (method, params = {}) => new Promise(resolve => { const id = String(++seq); pending.set(id, resolve); ws.send(JSON.stringify({ id, epoch, method, params })); });
    const snapshot = (await rpc('snapshot', { line })).result; epoch = snapshot.epoch;
    return { ws, events, rpc, snapshot };
  };
  const one = await connect(A), two = await connect(B);
  assert.notEqual(one.snapshot.epoch, two.snapshot.epoch);
  assert.deepEqual((await one.rpc('subscribe')).result, {}); assert.deepEqual((await two.rpc('subscribe')).result, {});
  const duplicate = await connect(A); assert.ok((await duplicate.rpc('subscribe')).error); duplicate.ws.close();
  const event = once(one.ws, 'message');
  a.sock.ws.emit('frame', { tag: 'ack', attrs: { class: 'call', id: 'only-A' } }); await event;
  assert.equal(one.events.length, 1); assert.equal(two.events.length, 0);
  const incoming = once(two.ws, 'message');
  assert.equal(await bridge.forwardCall(b.sock, { tag: 'call', attrs: { from: ALID, id: 'only-B' }, content: [
    { tag: 'offer', attrs: { 'call-id': 'in-B', 'call-creator': ALID }, content: [] },
  ] }), true); await incoming;
  assert.equal(one.events.length, 1); assert.equal(two.events.length, 1);
  const closed = once(one.ws, 'close'); a.sock.ev.emit('connection.update', { connection: 'close' }); await closed;
  assert.deepEqual((await two.rpc('privacyToken', { jid: ALID })).result, { token: '', timestamp: 0 });
});

test('produção: qualquer contato com número, só com várias linhas, pelo nome interno do compose', async t => {
  const base = { token: TOKEN, multiple: true, open: true, port: 19495, host: '127.0.0.1', hostname: 'evolution', utils };
  for (const errado of [{ allowed: [B] }, { multiple: false, line: A }, { hostname: 'localhost' }, { hostname: 'omni.filtrovali.com.br' }]) {
    assert.throws(() => new CallBridge({ ...base, ...errado }), /invalid_bridge_config/);
  }
  // Uma linha só (POC) não aceita o nome interno; o staging (várias linhas e lista) aceita.
  assert.throws(() => new CallBridge({ token: TOKEN, line: A, allowed: [B], port: 19494, hostname: 'evolution', utils }), /invalid_bridge_config/);
  const staging = new CallBridge({ token: TOKEN, multiple: true, allowed: [B], port: 19493, hostname: 'evolution', utils });
  await once(staging.http, 'listening'); t.after(() => staging.close());
  assert.equal(staging.permits(canonicalPhone(B)), true);
  assert.equal(staging.permits('4915112345678'), false);
  const bridge = new CallBridge(base);
  await once(bridge.http, 'listening');
  t.after(() => bridge.close());
  assert.equal(bridge.permits(canonicalPhone(B)), true);
  assert.equal(bridge.permits('4915112345678'), true);
  assert.equal(bridge.permits(null), false);
  const abrir = async host => {
    const ws = new WebSocket('ws://127.0.0.1:19495/v1/calls', { headers: { Authorization: 'Bearer ' + TOKEN, Host: host } }); ws.on('error', () => {});
    const [evento, resposta] = await Promise.race([once(ws, 'open').then(() => ['open']), once(ws, 'unexpected-response')]);
    ws.terminate();
    return evento === 'open' ? 101 : resposta.statusCode;
  };
  assert.equal(await abrir('evolution:19495'), 101);
  assert.equal(await abrir('127.0.0.1:19495'), 401);
  assert.equal(await abrir('omni.filtrovali.com.br:19495'), 401);
});
