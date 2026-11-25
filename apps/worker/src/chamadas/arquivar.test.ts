import { randomUUID } from "node:crypto";

import { createPool, createWorkerDb, migrate } from "@omni/db";
import { decifrarGravacao, desembrulharChave } from "@omni/integrations/gravacoes";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { arquivarGravacoes, type DepsArquivar } from "./arquivar.ts";

/** Gravações no SharePoint (0052): envio conferido, WAV apagado depois, exclusão definitiva. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
};
async function disponivel(): Promise<boolean> {
  const client = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();
const hex = () => randomUUID().replaceAll("-", "");
const MESTRA = Buffer.alloc(32, 7);
// "Áudio" reconhecível: se aparecer no arquivo enviado, a cifra falhou.
const AUDIO = new Uint8Array(1000).map((_, i) => 65 + (i % 26));

function deps(estado: { tamanhoErrado?: boolean; semWav?: Set<string> } = {}) {
  const enviados: string[] = [];
  const conteudos: Uint8Array[] = [];
  const apagadosSp: string[] = [];
  const apagadosVoz: string[] = [];
  const d: DepsArquivar = {
    driveId: "drive-teste",
    pasta: "Gravacoes-teste",
    mestra: MESTRA,
    async buscarWav(c) {
      return estado.semWav?.has(c.recordingId) ? null : AUDIO;
    },
    async apagarDoServico(c) {
      apagadosVoz.push(c.recordingId);
    },
    async comprimir(wav) {
      return wav.subarray(0, 100);
    },
    sharepoint: {
      async enviarArquivo(_d, caminho, conteudo) {
        enviados.push(caminho);
        conteudos.push(conteudo);
        return { id: `item-${enviados.length}`, tamanho: estado.tamanhoErrado ? conteudo.byteLength + 1 : conteudo.byteLength };
      },
      async apagarDefinitivo(_d, itemId) {
        apagadosSp.push(itemId);
      },
    },
  };
  return { d, enviados, conteudos, apagadosSp, apagadosVoz };
}

describe.skipIf(!available)("gravações no SharePoint", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let numero = "";
  let dono = "";
  const db = () => createWorkerDb(worker);
  const ligacao = async (extra: { fimHaMin?: number; expiraEmDias?: number } = {}) => {
    const rec = hex();
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO whatsapp_calls (number_id, owner_person_id, recording_id, peer, direction, state, created_at, started_at, ended_at, recording, audio, expires_at)
       VALUES ($1, $2, $3, '5547999990000', 'saida', 'encerrada', now() - interval '1 hour', now() - interval '1 hour', now() - make_interval(mins => $4), true, true, now() + make_interval(days => $5)) RETURNING id`,
      [numero, dono, rec, extra.fimHaMin ?? 5, extra.expiraEmDias ?? 1825],
    );
    return { id: rows[0]!.id, rec };
  };
  const linha = async (id: string) =>
    (await owner.query("SELECT arquivo_local, sp_item_id, arquivo_formato, arquivo_bytes, arquivamento_tentativas, sp_apagado_em IS NOT NULL apagado, audio, chave_cifrada, chave_versao FROM whatsapp_calls WHERE id = $1", [id])).rows[0];

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    // Ligações de outras rodadas não interferem.
    await owner.query("UPDATE whatsapp_calls SET arquivamento_tentativas = 5 WHERE arquivo_local = 'voz'");
    await owner.query("UPDATE whatsapp_calls SET sp_apagado_em = now() WHERE sp_item_id IS NOT NULL AND sp_apagado_em IS NULL");
    dono = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, 'Dono') RETURNING id", [`dono-${hex().slice(0, 8)}@filtrovali.com.br`])).rows[0]!.id;
    numero = (await owner.query<{ id: string }>("INSERT INTO whatsapp_numbers (instance_name, label, purpose, status, owner_person_id) VALUES ($1, 'Linha', 'outro', 'conectado', $2) RETURNING id", [`omni-${hex().slice(0, 10)}`, dono])).rows[0]!.id;
  });
  afterAll(async () => {
    await owner?.end();
    await worker?.end();
  });

  it("envia o M4A cifrado, confere, guarda a chave embrulhada e só então apaga o WAV; o caminho não tem nome nem telefone", async () => {
    const a = await ligacao();
    const recente = await ligacao({ fimHaMin: 0 }); // ainda fechando o arquivo: espera
    const t = deps();
    const r = await arquivarGravacoes(db(), t.d);
    expect(r).toMatchObject({ arquivadas: 1, erros: 0 });
    expect(t.enviados).toHaveLength(1);
    expect(t.enviados[0]).toMatch(new RegExp(`^Gravacoes-teste/\\d{4}/\\d{2}/${a.id}\\.m4a\\.cifrado$`));
    expect(t.apagadosVoz).toEqual([a.rec]);
    expect(await linha(a.id)).toMatchObject({ arquivo_local: "sharepoint", sp_item_id: "item-1", arquivo_formato: "m4a", arquivo_bytes: "100", audio: true, chave_versao: 1 });
    // No SharePoint só vai o arquivo cifrado; com a chave do banco e a mestra, volta o M4A.
    const enviado = Buffer.from(t.conteudos[0]!);
    expect(enviado.includes(Buffer.from(AUDIO.subarray(0, 32)))).toBe(false);
    const { chave_cifrada } = await linha(a.id);
    expect(Buffer.from(decifrarGravacao(enviado, desembrulharChave(chave_cifrada, MESTRA, a.id))).equals(Buffer.from(AUDIO.subarray(0, 100)))).toBe(true);
    expect(await linha(recente.id)).toMatchObject({ arquivo_local: "voz" });
    await owner.query("UPDATE whatsapp_calls SET arquivamento_tentativas = 5 WHERE id = $1", [recente.id]);
  });

  it("tamanho diferente: apaga o enviado, conta tentativa e mantém o WAV; sem WAV também conta tentativa", async () => {
    const a = await ligacao();
    const t = deps({ tamanhoErrado: true });
    expect((await arquivarGravacoes(db(), t.d)).erros).toBe(1);
    expect(t.apagadosSp).toEqual(["item-1"]);
    expect(t.apagadosVoz).toEqual([]);
    expect(await linha(a.id)).toMatchObject({ arquivo_local: "voz", arquivamento_tentativas: 1 });
    await owner.query("UPDATE whatsapp_calls SET arquivamento_tentativas = 5 WHERE id = $1", [a.id]);
    const b = await ligacao();
    const t2 = deps({ semWav: new Set([b.rec]) });
    expect((await arquivarGravacoes(db(), t2.d)).erros).toBe(1);
    expect(await linha(b.id)).toMatchObject({ arquivo_local: "voz", arquivamento_tentativas: 1 });
    await owner.query("UPDATE whatsapp_calls SET arquivamento_tentativas = 5 WHERE id = $1", [b.id]);
  });

  it("excluída pelo dono ou vencida: apaga de vez no SharePoint e marca; não repete", async () => {
    const excluida = await ligacao();
    const vencida = await ligacao();
    const t = deps();
    await arquivarGravacoes(db(), t.d);
    await owner.query("UPDATE whatsapp_calls SET deleted_at = now(), audio = false WHERE id = $1", [excluida.id]);
    expect((await linha(excluida.id)).chave_cifrada).toBeNull(); // excluir apaga a chave na hora (gatilho)
    await owner.query("UPDATE whatsapp_calls SET expires_at = now() - interval '1 minute' WHERE id = $1", [vencida.id]);
    const t2 = deps();
    expect((await arquivarGravacoes(db(), t2.d)).apagadas).toBe(2);
    expect(t2.apagadosSp.sort()).toEqual([(await linha(excluida.id)).sp_item_id, (await linha(vencida.id)).sp_item_id].sort());
    expect(await linha(vencida.id)).toMatchObject({ apagado: true, chave_cifrada: null });
    expect((await arquivarGravacoes(db(), deps().d)).apagadas).toBe(0);
  });
});
