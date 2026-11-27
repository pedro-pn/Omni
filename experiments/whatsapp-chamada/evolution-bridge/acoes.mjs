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

// Coleção do app state com os contatos salvos (contactAction), e as das ações que a ponte altera.
const COLECAO_CONTATOS = 'critical_unblock_low';
const OP_REMOVE = 1;
const versaoNum = (v) => Number(v?.toString?.() ?? v ?? 0) || 0;

/** Peças do Baileys da imagem (lib/omni-chamada/acoes.mjs → lib/Utils, WAProto). Nos testes, injetadas. */
async function baileysDaImagem() {
  const [u, w] = await Promise.all([import('../Utils/index.js'), import('../../WAProto/index.js')]);
  return { extractSyncdPatches: u.extractSyncdPatches, downloadExternalPatch: u.downloadExternalPatch, aesDecrypt: u.aesDecrypt, hkdf: u.hkdf, proto: w.proto };
}

export class PonteDeAcoes {
  constructor({ token, port = 8099, host = '127.0.0.1', hostname = '127.0.0.1', escutar = true, baileys = null }) {
    if (typeof token !== 'string' || token.length < 32 || !Number.isInteger(port) || port < 1024 || port > 65535 ||
        !['127.0.0.1', '0.0.0.0'].includes(host) || !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(hostname)) throw new Error('invalid_acoes_config');
    this.token = token;
    this.esperado = `${hostname}:${port}`;
    this.linhas = new Map(); // ws -> { sock, contatos (do histórico): Map<jid, contato> }
    this.baileys = baileys ? async () => baileys : baileysDaImagem;
    if (escutar) {
      this.http = createServer((req, res) => void this.atender(req, res));
      this.http.listen(port, host);
    }
  }

  attach(sock) {
    const linha = { sock, contatos: new Map(), eventos: 0, comNome: 0, historico: false };
    this.linhas.set(sock.ws, linha);
    // Só o que vem da agenda (contactAction e o histórico) traz `name`; o nome de perfil vem em `notify`.
    // Apagar só pela agenda (contacts.upsert vem do contactAction da coleção dos contatos): o
    // histórico das conversas traz um "contato" por conversa com `name` vazio quando a conversa não
    // tem o nome — tratado como apagado, tirava da lista quem a agenda tinha acabado de trazer.
    const guardar = (lista, podeApagar) => {
      for (const c of lista ?? []) {
        linha.eventos += 1;
        if (!c?.id || !PESSOA.test(String(c.id)) || !Object.prototype.hasOwnProperty.call(c, 'name')) continue;
        if (c.name) linha.comNome += 1;
        const nome = typeof c.name === 'string' ? c.name.trim().slice(0, 120) : '';
        if (nome && digitos(nome) !== digitos(String(c.id).split('@')[0])) {
          const antes = linha.contatos.get(c.id);
          linha.contatos.set(c.id, { jid: c.id, lid: c.lid ?? antes?.lid ?? null, telefone: c.phoneNumber ?? antes?.telefone ?? null, nome });
        } else if (podeApagar) linha.contatos.delete(c.id);
      }
    };
    sock.ev.on('contacts.upsert', (l) => guardar(l, true));
    sock.ev.on('contacts.update', (l) => guardar(l, false));
    // Histórico do pareamento: traz os contatos com o nome da agenda (só acrescenta).
    sock.ev.on('messaging-history.set', (h) => {
      if (Array.isArray(h?.contacts) && h.contacts.length) linha.historico = true;
      guardar(h?.contacts, false);
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
   * A agenda inteira, lida do servidor do WhatsApp SEM mexer no estado de sincronização do Baileys:
   * baixa a coleção dos contatos (snapshot e as alterações depois dele) e abre registro por
   * registro, pulando o que não abre. O resync do Baileys aborta a coleção inteira por um único
   * registro que não decifra ("bad decrypt" — registros estragados ficam no servidor e voltam a
   * cada pareamento; corrigido só no Baileys rc10, #2456) e, ao falhar, zera o estado local.
   */
  async lerAgendaDoServidor(linha) {
    const B = await this.baileys();
    const chaves = new Map();
    const chaveDe = async (idBytes) => {
      const id = Buffer.from(idBytes).toString('base64');
      if (!chaves.has(id)) {
        const k = (await linha.sock.authState.keys.get('app-state-sync-key', [id]))?.[id];
        // As chaves da mutação (mesma derivação do Baileys: HKDF de 160 bytes).
        // A Evolution 2.3.7 grava keyData como texto base64 (toJSON do protobuf); com o patch da imagem
        // volta como bytes. Aceita os dois.
        const bytes = typeof k?.keyData === 'string' ? Buffer.from(k.keyData, 'base64') : k?.keyData ? Buffer.from(k.keyData) : null;
        const e = bytes?.length ? Buffer.from(await B.hkdf(bytes, 160, { info: 'WhatsApp Mutation Keys' })) : null;
        chaves.set(id, e ? { valueEncryptionKey: e.subarray(32, 64) } : null);
      }
      return chaves.get(id);
    };
    const contatos = new Map();
    const d = { registros: 0, ignorados: 0, semChave: 0 };
    const aplicar = async (operacao, record) => {
      d.registros += 1;
      try {
        const k = await chaveDe(record.keyId.id);
        if (!k) {
          d.semChave += 1;
          return;
        }
        const blob = Buffer.from(record.value.blob);
        const acao = B.proto.SyncActionData.decode(B.aesDecrypt(blob.subarray(0, -32), k.valueEncryptionKey));
        const indice = JSON.parse(Buffer.from(acao.index).toString());
        if (indice[0] !== 'contact' || typeof indice[1] !== 'string') return;
        const jid = indice[1];
        const c = acao.value?.contactAction;
        const nome = String(c?.fullName || c?.firstName || '').trim().slice(0, 120);
        if (operacao !== OP_REMOVE && nome && PESSOA.test(jid) && digitos(nome) !== digitos(jid.split('@')[0])) {
          contatos.set(jid, { jid, lid: c.lidJid || (jid.endsWith('@lid') ? jid : null), telefone: c.pnJid || (jid.endsWith('@s.whatsapp.net') ? jid : null), nome });
        } else contatos.delete(jid);
      } catch {
        d.ignorados += 1; // registro que não abre: pula, os outros valem
      }
    };
    let versao = 0;
    for (let volta = 0; volta < 30; volta += 1) {
      const resposta = await linha.sock.query({
        tag: 'iq',
        attrs: { to: 's.whatsapp.net', xmlns: 'w:sync:app:state', type: 'set' },
        content: [{ tag: 'sync', attrs: {}, content: [{ tag: 'collection', attrs: { name: COLECAO_CONTATOS, version: String(versao), return_snapshot: String(versao === 0) } }] }],
      });
      const col = (await B.extractSyncdPatches(resposta, {}))[COLECAO_CONTATOS];
      if (!col) break;
      if (col.snapshot) {
        for (const rec of col.snapshot.records ?? []) await aplicar(0, rec);
        versao = versaoNum(col.snapshot.version?.version) || versao;
      }
      for (const p of col.patches ?? []) {
        const mutacoes = [...(p.mutations ?? [])];
        if (p.externalMutations) mutacoes.push(...((await B.downloadExternalPatch(p.externalMutations, {})).mutations ?? []));
        for (const m of mutacoes) await aplicar(m.operation ?? 0, m.record);
        versao = versaoNum(p.version?.version) || versao;
      }
      if (!col.hasMorePatches) break;
    }
    return { contatos, diagnostico: { ...d, versao } };
  }

  /** A agenda: a do servidor e, por cima do que ela não tem, o que o histórico do pareamento trouxe. */
  async contatos(linha) {
    const eventosAntes = linha.eventos;
    const mensagens = [];
    let lida = null;
    try {
      lida = await this.lerAgendaDoServidor(linha);
    } catch (e) {
      mensagens.push(`leitura: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
    }
    const todos = new Map(linha.contatos);
    if (lida) for (const [jid, c] of lida.contatos) todos.set(jid, c);
    return {
      contatos: [...todos.values()],
      completa: Boolean(lida) || linha.historico,
      diagnostico: {
        versaoDaColecao: lida?.diagnostico.versao ?? null,
        registros: lida?.diagnostico.registros ?? null,
        ignorados: lida?.diagnostico.ignorados ?? null,
        semChave: lida?.diagnostico.semChave ?? null,
        doServidor: lida?.contatos.size ?? null,
        doHistorico: linha.contatos.size,
        eventosNaLeitura: linha.eventos - eventosAntes,
      },
      mensagens,
    };
  }

  /**
   * Antes de alterar o app state (contato, fixar, favoritar): a coleção precisa estar sincronizada.
   * Com o estado zerado (sincronização falhou), o Baileys manda a alteração na versão 0 — o que
   * pode corromper os dados no servidor do WhatsApp (Baileys #2456). Recusa em vez de arriscar.
   */
  async exigirSincronizada(linha, colecao) {
    try {
      await linha.sock.resyncAppState([colecao], false);
    } catch {}
    const v = (await linha.sock.authState.keys.get('app-state-sync-version', [colecao]))?.[colecao];
    if (!(versaoNum(v?.version) > 0)) throw Object.assign(new Error('colecao_fora_de_sincronia'), { status: 409 });
  }

  async executar(corpo) {
    const l = this.linha(corpo?.telefone);
    const jid = String(corpo?.jid ?? '');
    switch (corpo?.acao) {
      case 'contatos':
        return await this.contatos(l);
      case 'contato': {
        const nome = String(corpo.nome ?? '').trim().slice(0, 120);
        if (!PESSOA.test(jid) || !nome) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        const primeiro = String(corpo.primeiroNome ?? nome.split(/\s+/)[0]).trim().slice(0, 60);
        await this.exigirSincronizada(l, COLECAO_CONTATOS);
        await l.sock.addOrEditContact(jid, { fullName: nome, firstName: primeiro, saveOnPrimaryAddressbook: true, ...(jid.endsWith('@s.whatsapp.net') ? { pnJid: jid } : { lidJid: jid }) });
        l.contatos.set(jid, { jid, lid: jid.endsWith('@lid') ? jid : null, telefone: jid.endsWith('@s.whatsapp.net') ? jid : null, nome });
        return { ok: true };
      }
      case 'fixar-conversa':
        if (!PESSOA.test(jid) && !GRUPO.test(jid)) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        await this.exigirSincronizada(l, 'regular_low');
        await l.sock.chatModify({ pin: corpo.fixar === true }, jid);
        return { ok: true };
      case 'favoritar':
        if ((!PESSOA.test(jid) && !GRUPO.test(jid)) || !ID.test(String(corpo.id ?? ''))) throw Object.assign(new Error('dados_invalidos'), { status: 400 });
        await this.exigirSincronizada(l, 'regular_low');
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
