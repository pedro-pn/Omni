import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { bareJID, canonicalPhone, decodeNode, encodeNode, fromBase64, isCallNode, isVoiceOffer } from './protocol.mjs';

// Uma única Evolution continua dona do socket, do Signal e de todas as mensagens.
// Nenhuma chave privada, sessão Signal ou credencial Noise sai deste processo.
export class CallBridge {
  // open: produção — qualquer contato com número (cada pessoa usa o próprio WhatsApp),
  // só com várias linhas (integração do Omni) e sem lista de teste.
  // hostname: nome com que o serviço de voz chega à ponte (127.0.0.1, ou, com a
  // integração do Omni, o nome do serviço na rede interna do compose: "evolution").
  constructor({ token, line, allowed, multiple = false, open = false, port = 8097, host = '127.0.0.1', hostname = '127.0.0.1', utils }) {
    if (typeof token !== 'string' || token.length < 32 || (!multiple && !canonicalPhone(line)) ||
        (open ? (!multiple || allowed?.length) : (!allowed?.length || allowed.some(p => !canonicalPhone(p)))) ||
        !(hostname === '127.0.0.1' || (multiple && hostname !== 'localhost' && /^[a-z][a-z0-9-]{0,62}$/.test(hostname))) ||
        !['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_bridge_config');
    this.token = token;
    this.line = canonicalPhone(line);
    this.open = open;
    this.allowed = new Set((allowed ?? []).map(canonicalPhone));
    this.utils = utils;
    this.sessions = new Map();
    this.clients = new Set();
    this.leases = new Map();
    this.multiple = multiple;
    this.lease = null;
    this.http = createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
    this.http.on('upgrade', (req, socket, head) => {
      const received = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from('Bearer ' + this.token);
      if (req.url !== '/v1/calls' || req.headers.origin ||
          req.headers.host !== `${hostname}:${port}` ||
          received.length !== expected.length || !timingSafeEqual(received, expected)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      if ((!this.multiple && this.clients.size > 0) || this.clients.size >= 64) {
        socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws));
    });
    this.http.listen(port, host);
  }

  attach(sock) {
    const entry = { sock, epoch: randomUUID(), open: sock.ws.isOpen, calls: new Map() };
    this.sessions.set(sock.ws, entry);
    sock.ev.on('connection.update', update => {
      if (update.connection === 'open') entry.open = true;
      if (update.connection === 'close') {
        entry.open = false;
        this.sessions.delete(sock.ws);
        this.leases.get(sock.ws)?.client.close(1012, 'evolution_reconnect');
      }
    });
    sock.ws.on('frame', node => {
      if (node?.tag === 'ack' && node.attrs?.class === 'call') this.leases.get(sock.ws)?.event(node);
    });
    return sock;
  }

  selected() {
    const entries = [...this.sessions.values()].filter(e => e.open && e.sock.ws.isOpen &&
      canonicalPhone(e.sock.authState.creds.me?.id?.split(':')[0]?.split('@')[0]) === this.line);
    if (entries.length !== 1) throw new Error('line_unavailable');
    return entries[0];
  }

  // Executado ANTES do handler normal: somente um dono envia ACK e usa o Signal.
  async forwardCall(sock, node) {
    const client = this.leases.get(sock.ws);
    return client ? client.handleCall(sock, node) : false;
  }

  async handleCall(sock, node) {
    const entry = this.sessions.get(sock.ws);
    if (!entry || entry !== this.lease || this.client?.readyState !== WebSocket.OPEN) return false;
    const child = node.content?.[0];
    const id = child?.attrs?.['call-id'];
    const now = Date.now();
    this.pruneCalls(entry);
    if (!entry.calls.has(id)) {
      if (typeof id !== 'string' || !isVoiceOffer(node) || entry.calls.size >= 16) return false;
      try {
        // O servidor pode informar o telefone junto de um criador endereçado por
        // LID. Guarda o vínculo na própria Evolution antes de decriptar a oferta.
        const creator = child.attrs['call-creator'];
        const pn = child.attrs.caller_pn;
        if (creator?.endsWith('@lid') && pn?.endsWith('@s.whatsapp.net') &&
            this.permits(canonicalPhone(bareJID(pn).split('@')[0]))) {
          await entry.sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: bareJID(creator), pn: bareJID(pn) }]);
        }
        await this.peer(entry, node.attrs.from);
      } catch { return false; }
      if (this.lease !== entry || this.client?.readyState !== WebSocket.OPEN) return false;
      entry.calls.set(id, now + 660_000);
    }
    this.event(node);
    return true;
  }

  event(node) {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    if (this.client.bufferedAmount > 1024 * 1024) { this.client.close(1013, 'slow_reader'); return; }
    this.client.send(JSON.stringify({ event: 'node', epoch: this.lease.epoch, node: encodeNode(node) }));
  }

  pruneCalls(entry) {
    for (const [key, expiry] of entry.calls) if (expiry < Date.now()) entry.calls.delete(key);
  }

  accept(ws) {
    // Cada cliente tem sua própria linha/geração. O registro de sockets é
    // compartilhado; áudio, eventos e estado nunca atravessam essas leases.
    const session = Object.create(this);
    session.parent = this;
    session.lease = null;
    session.candidate = null;
    session.client = ws;
    this.clients.add(session);
    let inFlight = 0;
    ws.on('error', () => {});
    ws.on('close', () => {
      if (session.lease && this.leases.get(session.lease.sock.ws) === session) this.leases.delete(session.lease.sock.ws);
      session.lease?.calls.clear(); session.lease = null; session.client = null;
      this.clients.delete(session);
    });
    ws.on('message', async (data, binary) => {
      let request;
      if (binary || ++inFlight > 32) { ws.close(1008, 'invalid_request'); return; }
      try {
        request = JSON.parse(data.toString());
        if (typeof request.id !== 'string' || request.id.length > 100 || typeof request.method !== 'string') throw new Error('invalid_request');
        const result = await session.dispatch(request, ws);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
      } catch {
        // Nunca serializar erros internos: podem conter chaves, JIDs ou nós.
        if (request?.id && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, error: 'bridge_request_failed' }));
        else ws.close(1008, 'invalid_request');
      } finally { inFlight--; }
    });
  }

  /** Número que a ponte aceita: na produção, qualquer um válido; senão, só os da lista de teste. */
  permits(phone) { return Boolean(phone) && (this.open || this.allowed.has(phone)); }

  async peer(entry, jid) {
    const bare = bareJID(jid);
    let pn = bare;
    if (bare.endsWith('@lid')) pn = await entry.sock.signalRepository.lidMapping.getPNForLID(bare);
    const phone = pn && canonicalPhone(bareJID(pn).split('@')[0]);
    if (!this.permits(phone)) throw new Error('peer_not_allowed');
    return bare;
  }

  async dispatch({ method, params = {}, epoch }, client) {
    const checkClient = () => {
      if (client !== this.client || client.readyState !== WebSocket.OPEN) throw new Error('client_closed');
    };
    checkClient();
    if (method === 'snapshot') {
      const line = canonicalPhone(params.line || this.parent.line);
      if (!line || (!this.multiple && line !== this.parent.line)) throw new Error('invalid_line');
      if (this.lease && line !== this.line) throw new Error('already_subscribed');
      this.line = line;
      const entry = this.selected();
      const { me, account } = entry.sock.authState.creds;
      if (!me.lid || !account) throw new Error('identity_unavailable');
      this.candidate = entry;
      return { version: 1, epoch: entry.epoch, id: me.id, lid: me.lid,
        account: Buffer.from(this.utils.encodeSignedDeviceIdentity(account, true)).toString('base64') };
    }
    const entry = this.selected();
    const checkSession = () => { checkClient(); if (this.selected() !== entry || this.lease !== entry) throw new Error('stale_session'); };
    if (epoch !== entry.epoch || (this.lease && this.lease !== entry)) throw new Error('stale_session');
    if (method === 'subscribe') {
      if (this.candidate !== entry) throw new Error('snapshot_required');
      const previous = this.leases.get(entry.sock.ws);
      if (previous && previous !== this) throw new Error('line_busy');
      this.lease = entry;
      this.leases.set(entry.sock.ws, this);
      return {};
    }
    if (this.lease !== entry) throw new Error('subscribe_required');
    const sock = entry.sock;
    switch (method) {
      case 'send': {
        const node = decodeNode(params.node);
        if (!isCallNode(node)) throw new Error('call_only');
        await this.peer(entry, node.attrs.to);
        checkSession();
        if (node.tag === 'call') {
          const child = node.content?.[0];
          if (!child?.attrs?.['call-id']) throw new Error('missing_call_id');
          if (child.tag === 'offer') {
            this.pruneCalls(entry);
            if (!isVoiceOffer(node) || entry.calls.size >= 16) throw new Error('voice_only');
            entry.calls.set(child.attrs['call-id'], Date.now() + 660_000);
          }
        }
        await sock.sendNode(node);
        return {};
      }
      case 'resolveLID': {
        const jid = await this.peer(entry, params.jid);
        let normalized = jid;
        if (!jid.endsWith('@lid')) {
          // onWhatsApp devolve o JID efetivo da conta, inclusive números
          // brasileiros registrados sem o nono dígito.
          const [user] = await sock.onWhatsApp(jid);
          if (!user?.exists) throw new Error('peer_unavailable');
          normalized = await this.peer(entry, user.jid);
        }
        checkSession();
        const lid = normalized.endsWith('@lid') ? normalized : await sock.signalRepository.lidMapping.getLIDForPN(normalized);
        if (!lid) throw new Error('lid_unavailable');
        return { jid: lid };
      }
      case 'resolvePN': {
        const jid = bareJID(params.jid);
        const pn = jid.endsWith('@lid') ? await sock.signalRepository.lidMapping.getPNForLID(jid) : jid;
        await this.peer(entry, pn);
        return { jid: pn };
      }
      case 'devices': {
        if (!Array.isArray(params.jids) || params.jids.length > 8) throw new Error('invalid_users');
        for (const jid of params.jids) await this.peer(entry, jid);
        const devices = await sock.getUSyncDevices(params.jids, true, false);
        return { jids: devices.map(d => d.jid || this.utils.jidEncode(d.user, d.server, d.device)) };
      }
      case 'ensureSessions': {
        if (!Array.isArray(params.jids) || params.jids.length > 32) throw new Error('invalid_devices');
        for (const jid of params.jids) await this.peer(entry, jid);
        await sock.assertSessions(params.jids, false);
        return {};
      }
      case 'encrypt': {
        await this.peer(entry, params.jid);
        const plaintext = fromBase64(params.plaintext);
        this.callKey(plaintext);
        await sock.assertSessions([params.jid], false);
        checkSession();
        const { type, ciphertext } = await sock.signalRepository.encryptMessage({ jid: params.jid, data: this.utils.writeRandomPadMax16(plaintext) });
        return { node: encodeNode({ tag: 'enc', attrs: { v: '2', type }, content: ciphertext }), identity: type === 'pkmsg' };
      }
      case 'decrypt': {
        await this.peer(entry, params.jid);
        const node = decodeNode(params.node);
        if (node.tag !== 'enc' || !['msg', 'pkmsg'].includes(node.attrs.type)) throw new Error('invalid_enc');
        checkSession();
        const padded = await sock.signalRepository.decryptMessage({ jid: params.jid, type: node.attrs.type, ciphertext: node.content });
        const plaintext = Buffer.from(this.utils.unpadRandomMax16(padded));
        this.callKey(plaintext);
        return { plaintext: plaintext.toString('base64') };
      }
      case 'privacyToken': {
        const jid = await this.peer(entry, params.jid);
        const tokens = await sock.authState.keys.get('tctoken', [jid]);
        const token = tokens[jid];
        return { token: token?.token ? Buffer.from(token.token).toString('base64') : '', timestamp: Number(token?.timestamp || 0) };
      }
      default: throw new Error('unknown_method');
    }
  }

  // Só chaves de chamada atravessam a ponte (nunca conversas). O WhatsApp do iPhone
  // manda a chave junto de metadados de aparelhos (messageContextInfo): aceitos, sem
  // abrir exceção para qualquer outro conteúdo.
  callKey(plaintext) {
    const message = this.utils.decodeMessage(plaintext);
    const permitidos = new Set(['call', 'messageContextInfo']);
    if (message.call?.callKey?.length !== 32 || Object.keys(message).some(k => !permitidos.has(k))) throw new Error('call_key_only');
  }

  async close() {
    for (const session of this.clients) session.client?.terminate();
    await new Promise(resolve => this.wss.close(resolve));
    await new Promise(resolve => this.http.close(resolve));
  }
}
