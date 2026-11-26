import { describe, expect, it } from "vitest";

import type { Saude } from "../../lib/saude-fns.ts";
import { niveis } from "./Saude.tsx";

const agora = "2026-11-26T12:00:00.000Z";
const faixa = { n: 1000, erros: 0, mediaMs: 80, p95Ms: 250 };
const base: Saude = {
  agora,
  web: { versao: "abc", memoriaMb: 200, desde: agora, ultimaHora: faixa, ultimoDia: faixa },
  worker: { versao: "abc", memoriaMb: 300, desde: agora, visto: "2026-11-26T11:58:00.000Z" },
  backup: {
    local: { status: "SUCCESS", em: "2026-11-26T08:20:00.000Z" },
    remoto: { status: "SUCCESS", em: "2026-11-26T02:20:00.000Z" },
    ensaio: { status: "SUCCESS", em: "2026-11-02T04:50:00.000Z" },
    visto: agora,
  },
  jobs: [{ nome: "retencao", ultimaOk: agora, falhas24h: 0, naFila: 0, emExecucao: 0 }],
  banco: { tamanhoMb: 300, conexoes: 20, conexoesMax: 100, maiores: [] },
  errosAbertos: 0,
  filtroapp: { missoesAtivas: 44, ultimaSincronizacao: "2026-11-26T11:40:00.000Z" },
};

describe("sinais do painel de saúde (E20)", () => {
  it("tudo verde quando está tudo certo", () => {
    expect(niveis(base)).toEqual({ web: "ok", worker: "ok", backup: "ok", jobs: "ok", banco: "ok", erros: "ok", filtroapp: "ok" });
  });

  it("acende o que passou do limite", () => {
    const s: Saude = {
      ...base,
      web: { ...base.web, ultimoDia: { ...faixa, erros: 20 } },
      worker: { ...base.worker!, visto: "2026-11-26T11:30:00.000Z" },
      backup: { ...base.backup!, remoto: { status: "SUCCESS", em: "2026-11-25T02:20:00.000Z" } },
      jobs: [{ ...base.jobs[0]!, falhas24h: 2 }],
      banco: { ...base.banco, conexoes: 90 },
      errosAbertos: 3,
      filtroapp: { ...base.filtroapp, ultimaSincronizacao: "2026-11-26T08:00:00.000Z" },
    };
    expect(niveis(s)).toEqual({ web: "atencao", worker: "problema", backup: "problema", jobs: "atencao", banco: "problema", erros: "atencao", filtroapp: "atencao" });
  });

  it("backup que falhou é problema; sem backup no ambiente, nada", () => {
    expect(niveis({ ...base, backup: { ...base.backup!, ensaio: { status: "FAILED", em: agora } } }).backup).toBe("problema");
    expect(niveis({ ...base, backup: null }).backup).toBeNull();
    expect(niveis({ ...base, worker: null }).worker).toBe("problema");
  });
});
