// Ponte de ações do Omni dentro da Evolution (Baileys): o que o WhatsApp faz e a Evolution
// 2.3.7 não expõe em rota — a agenda do celular (nome salvo separado do nome de perfil),
// adicionar/editar contato (salva no celular, vale em todos os aparelhos), fixar conversa,
// favoritar e fixar mensagem. Só na rede interna do compose, com token; desligada sem
// OMNI_ACOES_TOKEN. Cada linha é achada pelo número da sessão (creds.me).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const PESSOA = /^\d{5,20}@(s\.whatsapp\.net|lid)$/;
const GRUPO = /^[\d-]{6,40}@g\.us$/;
const ID = /^[A-Za-z0-9_-]{4,128}$/;
const MAX_CORPO = 64 * 1024;
const digitos = (s) => String(s ?? '').replace(/\D/g, '');
const SETE_DIAS = 7 * 24 * 3600;

/** Durante a leitura, copia as mensagens de sincronização do log do Baileys (só o texto e a primeira linha do erro). */
function escutarLog(logger, destino) {
  if (!logger) return () => {};
  const originais = {};
  for (const nivel of ['info', 'warn', 'error', 'debug']) {
    if (typeof logger[nivel] !== 'function') continue;
    originais[nivel] = logger[nivel];
    logger[nivel] = function (obj, msg) {
      try {
        const texto = typeof obj === 'string' ? obj : String(msg ?? '');
        if (/sync|snapshot|app.?state|patch|key/i.test(texto) && destino.length < 20) {
          const erro = obj && typeof obj === 'object' ? String(obj.error ?? obj.err?.stack ?? obj.err?.message ?? '').split('\n')[0] : '';
          destino.push(`${nivel}: ${texto.slice(0, 160)}${erro ? ` — ${erro.slice(0, 200)}` : ''}`);
        }
      } catch {}
      return originais[nivel].apply(this, arguments);
    };
  }
  return () => Object.assign(logger, originais);
}

export class PonteDeAcoes {
  constructor({ token, port = 8099, host = '127.0.0.1', hostname = '127.0.0.1', escutar = true }) {
    if (typeof token !== 'string' || token.length < 32 || !Number.isInteger(port) || port < 1024 || port > 65535 ||
        !['127.0.0.1', '0.0.0.0'].includes(host) || !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(hostname)) throw new Error('invalid_acoes_config');
    this.token = token;
    this.esperado = `${hostname}:${port}`;
    this.linhas = new Map(); // ws -> { sock, contatos: Map<jid, contato>, sincronizado }
    if (escutar) {
      this.http = createServer((req, res) => void this.atender(req, res));
      this.http.listen(port, host);
    }
  }

  attach(sock, logger = null) {
    const linha = { sock, logger, contatos: new Map(), sincronizado: false, eventos: 0, comNome: 0, historico: false };
    this.linhas.set(sock.ws, linha);
    // Só o que vem da agenda (contactAction e o histórico) traz `name`; o nome de perfil vem em `notify`.
    const guardar = (lista) => {
      for (const c of lista ?? []) {
        linha.eventos += 1;
        if (!c?.id || !Object.prototype.hasOwnProperty.call(c, 'name')) continue;
        if (c.name) linha.comNome += 1;
        const nome = typeof c.name === 'string' ? c.name.trim().slice(0, 120) : '';
        if (nome && digitos(nome) !== digitos(String(c.id).split('@')[0])) {
          linha.contatos.set(c.id, { jid: c.id, lid: c.lid ?? null, telefone: c.phoneNumber ?? null, nome });
        } else linha.contatos.delete(c.id);
      }
    };
    sock.ev.on('contacts.upsert', guardar);
    sock.ev.on('contacts.update', guardar);
    // Histórico do pareamento: traz os contatos com o nome da agenda.
    sock.ev.on('messaging-history.set', (h) => {
      if (Array.isArray(h?.contacts) && h.contacts.length) linha.historico = true;
      guardar(h?.contacts);
    });
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'close') this.linhas.delete(sock.ws);
    });
    return sock;
  }

  linha(telefone) {
    const n = digitos(telefone);
    const abertas = [...this.linhas.values()].filter((l) => l.sock.ws?.isOpen && digitos(l.sock.authState?.creds?.me?.id?.split(':')[0]?.split('@')[0]) === n);
    if (!n || abertas.length !== 1) throw Object.assign(new Error('linha_indisponivel'), { status: 409 });
    return abertas[0];
  }

  /**
   * A agenda inteira: na primeira vez, baixa de novo a coleção dos contatos (snapshot). O
   * diagnóstico diz quantos contatos o WhatsApp mandou e se a coleção baixou (versão > 0); o
   * Baileys não devolve erro quando a coleção falha (só registra no log).
   */
  async contatos(linha, recarregar = false) {
    const antes = { eventos: linha.eventos, comNome: linha.comNome };
    let versao = null;
    const mensagens = [];
    if (!linha.sincronizado || recarregar) {
      // O Baileys não devolve erro quando a coleção falha: só registra no log (que pode estar
      // desligado). Durante a leitura, guarda as mensagens de sincronização (sem os dados).
      const desfazer = escutarLog(linha.logger, mensagens);
      try {
        await linha.sock.authState.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
        await linha.sock.resyncAppState(['critical_unblock_low'], true);
      } finally {
        desfazer();
      }
      const v = await linha.sock.authState.keys.get('app-state-sync-version', ['critical_unblock_low']);
      versao = v?.critical_unblock_low?.version ?? 0;
      linha.sincronizado = versao > 0;
      if (versao > 0) linha.colecaoBaixada = true;
    }
    return {
      contatos: [...linha.contatos.values()],
      // Completa: a coleção dos contatos baixou ou o histórico do pareamento chegou nesta sessão.
      completa: Boolean(linha.colecaoBaixada || linha.historico),
      diagnostico: { versaoDaColecao: versao, eventosNaLeitura: linha.eventos - antes.eventos, comNomeNaLeitura: linha.comNome - antes.comNome, eventosDesdeOInicio: linha.eventos, salvosEmMemoria: linha.contatos.size },
      mensagens,
    };
  }

  async executar(corpo) {
    const l = this.linha(corpo?.telefone);
    const jid = String(corpo?.jid ?? '');
    switch (corpo?.acao) {
      case 'contatos':
        return await this.contatos(l, corpo.recarregar === true);
      case 'contato': {
        const nome = String(corpo.nome ?? '').trim().slice(0, 120);
        if (!PESSOA.test(jid) || !nome) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        const primeiro = String(corpo.primeiroNome ?? nome.split(/\s+/)[0]).trim().slice(0, 60);
        await l.sock.addOrEditContact(jid, { fullName: nome, firstName: primeiro, saveOnPrimaryAddressbook: true, ...(jid.endsWith('@s.whatsapp.net') ? { pnJid: jid } : { lidJid: jid }) });
        l.contatos.set(jid, { jid, lid: jid.endsWith('@lid') ? jid : null, telefone: jid.endsWith('@s.whatsapp.net') ? jid : null, nome });
        return { ok: true };
      }
      case 'fixar-conversa':
        if (!PESSOA.test(jid) && !GRUPO.test(jid)) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        await l.sock.chatModify({ pin: corpo.fixar === true }, jid);
        return { ok: true };
      case 'favoritar':
        if ((!PESSOA.test(jid) && !GRUPO.test(jid)) || !ID.test(String(corpo.id ?? ''))) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        await l.sock.chatModify({ star: { messages: [{ id: corpo.id, fromMe: corpo.fromMe === true }], star: corpo.favorita === true } }, jid);
        return { ok: true };
      case 'lids': {
        // Marcações nos grupos: o telefone por trás de cada @lid, pelo mapeamento que o Baileys
        // já guardou na sessão (nada é perguntado ao WhatsApp), e o meu @lid.
        const lids = Array.isArray(corpo.lids) ? corpo.lids.filter((x) => typeof x === 'string' && /^\d{5,20}@lid$/.test(x)).slice(0, 100) : null;
        if (!lids) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        const mapa = {};
        for (const lid of lids) {
          let pn = null;
          try {
            pn = await l.sock.signalRepository?.lidMapping?.getPNForLID(lid);
          } catch {}
          const d = digitos(String(pn ?? '').split(':')[0].split('@')[0]);
          mapa[lid] = String(pn ?? '').endsWith('@s.whatsapp.net') && d.length >= 8 && d.length <= 15 ? d : null;
        }
        const eu = digitos(String(l.sock.authState?.creds?.me?.lid ?? '').split(':')[0].split('@')[0]);
        return { mapa, eu: eu ? `${eu}@lid` : null };
      }
      case 'fixar-mensagem': {
        if ((!PESSOA.test(jid) && !GRUPO.test(jid)) || !ID.test(String(corpo.id ?? ''))) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        const participante = typeof corpo.participante === 'string' && PESSOA.test(corpo.participante) ? corpo.participante : undefined;
        await l.sock.sendMessage(jid, { pin: { remoteJid: jid, fromMe: corpo.fromMe === true, id: corpo.id, ...(participante ? { participant: participante } : {}) }, type: corpo.fixar === true ? 1 : 2, time: SETE_DIAS });
        return { ok: true };
      }
      default:
        throw Object.assign(new Error('acao_desconhecida'), { status: 400 });
    }
  }

  autorizado(req) {
    const recebido = Buffer.from(String(req.headers.authorization ?? ''));
    const esperado = Buffer.from('Bearer ' + this.token);
    return req.method === 'POST' && req.url === '/v1/acoes' && !req.headers.origin && req.headers.host === this.esperado &&
      recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
  }

  async atender(req, res) {
    const responder = (status, corpo) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(corpo));
    };
    if (!this.autorizado(req)) return responder(401, { erro: 'nao_autorizado' });
    let texto = '';
    try {
      for await (const parte of req) {
        texto += parte;
        if (texto.length > MAX_CORPO) return responder(413, { erro: 'grande_demais' });
      }
      return responder(200, await this.executar(JSON.parse(texto)));
    } catch (e) {
      // Só o código: nada de dados da conversa no log.
      return responder(e?.status ?? 502, { erro: e?.status ? e.message : 'falhou' });
    }
  }
}
