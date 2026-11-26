// Este arquivo é instalado dentro de baileys/lib/omni-chamada/.
import { proto } from '../../WAProto/index.js';
import { encodeSignedDeviceIdentity, writeRandomPadMax16, unpadRandomMax16 } from '../Utils/index.js';
import { jidEncode } from '../WABinary/index.js';
import { CallBridge } from './bridge.mjs';
import { PonteDeAcoes } from './acoes.mjs';

let bridge;
let acoes;
export function attachCalls(sock, config) {
  // Ponte de ações do Omni (agenda, contato, fixar, favoritar): independente das chamadas.
  if (process.env.OMNI_ACOES_TOKEN) {
    acoes ??= new PonteDeAcoes({
      token: process.env.OMNI_ACOES_TOKEN,
      port: Number(process.env.OMNI_ACOES_PORTA || '8099'),
      host: process.env.OMNI_ACOES_BIND || '127.0.0.1',
      hostname: process.env.OMNI_ACOES_HOST || '127.0.0.1',
    });
    acoes.attach(sock, config?.logger);
  }
  // teste: uma linha e lista de números; omni: várias linhas (Omni) e lista;
  // producao: várias linhas e qualquer contato, pela rede interna do compose.
  const modo = process.env.OMNI_CHAMADA_PONTE;
  if (!['teste', 'omni', 'producao'].includes(modo)) return sock;
  bridge ??= new CallBridge({
    token: process.env.OMNI_CHAMADA_TOKEN,
    line: process.env.OMNI_CHAMADA_LINHA,
    multiple: modo !== 'teste',
    open: modo === 'producao',
    allowed: (process.env.OMNI_CHAMADA_NUMEROS || '').split(',').map(s => s.trim()).filter(Boolean),
    port: Number(process.env.OMNI_CHAMADA_PORTA || '8097'),
    host: process.env.OMNI_CHAMADA_BIND || '127.0.0.1',
    hostname: process.env.OMNI_CHAMADA_HOST || '127.0.0.1',
    utils: { encodeSignedDeviceIdentity, writeRandomPadMax16, unpadRandomMax16, jidEncode,
      decodeMessage: data => proto.Message.decode(data) },
  });
  return bridge.attach(sock);
}

export async function forwardCall(sock, node) { return bridge ? bridge.forwardCall(sock, node) : false; }
