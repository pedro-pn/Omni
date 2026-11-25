// Servidor de integração Go ↔ Node; exclusivamente com identidades efêmeras.
import { CallBridge } from './bridge.mjs';
import { fixture, A, B, ALID, BLID, TOKEN, utils } from './fixture.mjs';
import { proto } from '../../WAProto/index.js';
const f = await fixture();
const bridge = new CallBridge({ token: TOKEN, line: A, allowed: [B], port: 19498, utils });
bridge.attach(f.sock);
f.sock.sendNode = async node => {
  if (node.tag === 'call' && node.content?.[0]?.tag === 'offer') {
    const offer = node.content[0];
    const enc = offer.content.find(n => n.tag === 'enc');
    if (!enc) throw new Error('missing_call_key');
    const padded = await f.remote.signalRepository.decryptMessage({ jid: ALID.replace('@', ':3@'), type: enc.attrs.type, ciphertext: enc.content });
    const message = proto.Message.decode(utils.unpadRandomMax16(padded));
    if (message.call?.callKey?.length !== 32) throw new Error('invalid_call_key');
    // Simula o servidor encerrando uma chamada. O motor deve injetar o evento
    // e enviar seu ACK pela ponte, enquanto o leitor RPC continua funcionando.
    setTimeout(() => bridge.forwardCall(f.sock, { tag: 'call', attrs: { id: 'fixture-terminate', from: BLID, t: String(Math.floor(Date.now() / 1000)) },
      content: [{ tag: 'terminate', attrs: { 'call-id': offer.attrs['call-id'], 'call-creator': ALID, reason: 'fixture' } }] }), 100);
  }
  if (node.tag === 'ack' && node.attrs.id === 'fixture-terminate') {
    const plaintext = proto.Message.encode({ call: { callKey: Buffer.alloc(32, 8) } }).finish();
    const reply = await f.remote.signalRepository.encryptMessage({ jid: ALID.replace('@', ':3@'), data: utils.writeRandomPadMax16(plaintext) });
    setTimeout(() => bridge.forwardCall(f.sock, { tag: 'call', attrs: { id: 'fixture-inbound', from: BLID, t: String(Math.floor(Date.now() / 1000)) },
      content: [{ tag: 'offer', attrs: { 'call-id': '22222222222222222222222222222222', 'call-creator': BLID }, content: [
        { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
        { tag: 'enc', attrs: { v: '2', type: reply.type }, content: reply.ciphertext },
      ] }] }), 50);
  }
};
console.log('INTEROP_FIXTURE_READY');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await bridge.close(); process.exit(0); });
