import { describe, expect, it } from "vitest";

import { metadadosDaPagina } from "./link-previa.ts";

describe("prévia de link", () => {
  it("lê Open Graph, resolve a imagem relativa e decodifica entidades", () => {
    const html = `<html><head><title>Ignorado</title>
      <meta property="og:title" content="Filtragem &amp; Óleo">
      <meta name="description" content='Descrição &quot;curta&quot;'>
      <meta property="og:image" content="/img/capa.jpg">
      <meta property="og:site_name" content="Exemplo">
    </head></html>`;
    expect(metadadosDaPagina(html, "https://www.exemplo.com.br/pagina")).toEqual({
      url: "https://www.exemplo.com.br/pagina",
      titulo: "Filtragem & Óleo",
      descricao: 'Descrição "curta"',
      imagem: "https://www.exemplo.com.br/img/capa.jpg",
      site: "Exemplo",
    });
  });
  it("sem og:title usa o <title>; sem título, sem prévia; imagem que não é http fica de fora", () => {
    expect(metadadosDaPagina(`<title>Só o título</title><meta property="og:image" content="javascript:alert(1)">`, "https://site.invalid/")).toMatchObject({
      titulo: "Só o título",
      imagem: null,
      site: "site.invalid",
    });
    expect(metadadosDaPagina("<html><body>nada</body></html>", "https://site.invalid/")).toBeNull();
  });
});
