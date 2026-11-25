// Apenas testes: gera identidades efêmeras em memória, sem socket do WhatsApp.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { proto } from '../../WAProto/index.js';
import { makeLibSignalRepository } from '../Signal/libsignal.js';
import { initAuthCreds, Curve, generateSignalPubKey, encodeSignedDeviceIdentity, writeRandomPadMax16, unpadRandomMax16 } from '../Utils/index.js';
import { jidEncode } from '../WABinary/index.js';

export const A = '5511987654321';
export const B = '5511987654322';
export const ALID = '100000000001@lid';
export const BLID = '100000000002@lid';
export const TOKEN = 'fixture-only-'.repeat(4);
export const utils = { encodeSignedDeviceIdentity, writeRandomPadMax16, unpadRandomMax16, jidEncode,
  decodeMessage: bytes => proto.Message.decode(bytes) };

export function endpoint() {
  const data = {};
  const keys = {
    async get(type, ids) { return Object.fromEntries(ids.filter(id => data[type]?.[id] != null).map(id => [id, data[type][id]])); },
    async set(update) { for (const [type, values] of Object.entries(update)) Object.assign(data[type] ||= {}, values); },
    async transaction(fn) { return fn(); },
    isInTransaction() { return false; },
  };
  const authState = { creds: initAuthCreds(), keys };
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const signalRepository = makeLibSignalRepository(authState, logger, async () => []);
  return { authState, signalRepository, data };
}

export async function fixture() {
  const a = endpoint(), b = endpoint();
  a.authState.creds.me = { id: `${A}:3@s.whatsapp.net`, lid: ALID.replace('@', ':3@') };
  a.authState.creds.account = { details: Buffer.from([8, 1]), accountSignatureKey: randomBytes(32),
    accountSignature: randomBytes(64), deviceSignature: randomBytes(64) };
  const maps = [{ lid: ALID, pn: A + '@s.whatsapp.net' }, { lid: BLID, pn: B + '@s.whatsapp.net' }];
  await a.signalRepository.lidMapping.storeLIDPNMappings(maps);
  await b.signalRepository.lidMapping.storeLIDPNMappings(maps);
  const prekey = Curve.generateKeyPair();
  await b.authState.keys.set({ 'pre-key': { 1: prekey } });
  const c = b.authState.creds;
  await a.signalRepository.injectE2ESession({ jid: BLID, session: {
    registrationId: c.registrationId, identityKey: generateSignalPubKey(c.signedIdentityKey.public),
    signedPreKey: { keyId: c.signedPreKey.keyId, publicKey: generateSignalPubKey(c.signedPreKey.keyPair.public), signature: c.signedPreKey.signature },
    preKey: { keyId: 1, publicKey: generateSignalPubKey(prekey.public) },
  } });
  const sent = [];
  const ws = new EventEmitter(); ws.isOpen = true;
  const sock = { ...a, ev: new EventEmitter(), ws,
    async sendNode(node) { sent.push(node); },
    async assertSessions() {},
    async onWhatsApp() { return [{ jid: B + '@s.whatsapp.net', exists: true }]; },
    async getUSyncDevices() { return [{ jid: BLID, user: BLID.split('@')[0], device: 0, server: 'lid' }]; },
  };
  return { sock, remote: b, sent };
}
