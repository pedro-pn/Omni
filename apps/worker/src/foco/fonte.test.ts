import { describe, expect, it } from "vitest";

import { FocoError, fonteExportacao } from "./fonte.ts";

/** Leitura pela função de exportação do Foco (sem a chave de serviço). */

type Pedido = { url: string; metodo: string; cabecalhos: Record<string, string> };
function buscarFalso(respostas: Record<string, { status: number; corpo: unknown }>, pedidos: Pedido[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    pedidos.push({ url, metodo: String(init.method), cabecalhos: init.headers as Record<string, string> });
    const tabela = new URL(url).searchParams.get("p_tabela")!;
    const r = respostas[tabela] ?? { status: 200, corpo: null };
    return new Response(JSON.stringify(r.corpo), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fonteExportacao", () => {
  const URL_FOCO = "https://projeto.supabase.co";

  it("só GET, com a chave publicável e o segredo no cabeçalho; linhas, contagem e tabela que não existe", async () => {
    const pedidos: Pedido[] = [];
    const f = fonteExportacao(URL_FOCO, "sb_publishable_x", "segredo-da-exportacao-com-32-caracteres", null, undefined, buscarFalso(
      {
        tasks: { status: 200, corpo: [{ id: "t1" }] },
        notifications: { status: 200, corpo: { total: 3 } },
        project_departures: { status: 200, corpo: null },
        "auth.users": { status: 200, corpo: [{ id: "u1", email: "a@b.c" }] },
      },
      pedidos,
    ));
    expect(await f.tabela("tasks")).toEqual([{ id: "t1" }]);
    expect(await f.tabela("notifications")).toHaveLength(3);
    expect(await f.tabela("project_departures")).toBeNull();
    expect(await f.usuarios()).toEqual([{ id: "u1", email: "a@b.c" }]);
    expect(pedidos.every((p) => p.metodo === "GET" && p.url.startsWith(`${URL_FOCO}/rest/v1/rpc/omni_exportar?p_tabela=`))).toBe(true);
    expect(pedidos[0]!.cabecalhos).toMatchObject({ apikey: "sb_publishable_x", "x-omni-token": "segredo-da-exportacao-com-32-caracteres" });
    expect(pedidos.some((p) => p.url.includes("segredo"))).toBe(false); // o segredo nunca vai no endereço
  });

  it("explica a recusa e a função que falta", async () => {
    const recusa = fonteExportacao(URL_FOCO, "k", "s".repeat(32), null, undefined, buscarFalso({ tasks: { status: 403, corpo: { code: "42501", message: "não autorizado" } } }, []));
    await expect(recusa.tabela("tasks")).rejects.toThrow(/recusou a exportação/);
    const falta = fonteExportacao(URL_FOCO, "k", "s".repeat(32), null, undefined, buscarFalso({ tasks: { status: 404, corpo: { code: "PGRST202" } } }, []));
    await expect(falta.tabela("tasks")).rejects.toThrow(/omni_exportar não existe/);
  });

  it("anexos pela pasta do pacote, sem sair dela", async () => {
    const lidos: string[] = [];
    const f = fonteExportacao(URL_FOCO, "k", "s".repeat(32), "/pacote/", async (c) => (lidos.push(c), new Uint8Array([1, 2])), buscarFalso({}, []));
    expect(await f.arquivo("w/t1/foto.jpg")).toEqual(new Uint8Array([1, 2]));
    expect(lidos).toEqual(["/pacote/w/t1/foto.jpg"]);
    await expect(f.arquivo("../etc/passwd")).rejects.toThrow(FocoError);
    await expect(fonteExportacao(URL_FOCO, "k", "s".repeat(32), null).arquivo("x")).rejects.toThrow(/FOCO_ANEXOS_PASTA/);
  });
});
