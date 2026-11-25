import { describe, expect, it } from "vitest";

import { limparHtmlEmail, politicaDoQuadro } from "./email-html.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("HTML de e-mail", () => {
  it("mantém a formatação da assinatura e troca as imagens embutidas (cid:)", () => {
    const r = limparHtmlEmail(
      `<table width="600" style="font-family:Arial"><tr><td><b>Pedro</b><br><font color="#30503a">Filtrovali</font></td><td><img src="cid:image001.png@01DB" alt="logo" width="120"></td></tr></table>`,
      { imagensCid: new Map([["image001.png@01db", PNG]]), permitirExternas: false },
    );
    expect(r.html).toContain('<table width="600" style="font-family:Arial">');
    expect(r.html).toContain('<font color="#30503a">Filtrovali</font>');
    expect(r.html).toContain(`<img alt="logo" width="120" src="${PNG}" />`);
    expect(r.externasBloqueadas).toBe(0);
  });

  it("remove script, eventos, formulário, iframe e javascript:", () => {
    const r = limparHtmlEmail(
      `<p onclick="x()">Oi</p><script>alert(1)</script><iframe src="https://x"></iframe><form action="https://x"><input name="senha"></form><a href="javascript:alert(1)">clique</a><img src="x" onerror="alert(1)"><svg><script>1</script></svg>`,
      { imagensCid: new Map(), permitirExternas: true },
    );
    expect(r.html).not.toMatch(/script|onclick|onerror|iframe|<form|<input|javascript:|<svg/i);
    expect(r.html).toContain("<p>Oi</p>");
    expect(r.html).toContain('<a target="_blank" rel="noopener noreferrer nofollow">clique</a>');
  });

  it("imagens externas: bloqueadas por padrão (rastreamento), liberadas a pedido; relativas nunca", () => {
    const html = `<img src="https://rastreio.invalid/pixel.gif" width="1"><img src="/api/emails/x"><a href="https://site.invalid/a">site</a>`;
    const bloqueado = limparHtmlEmail(html, { imagensCid: new Map(), permitirExternas: false });
    expect(bloqueado.externasBloqueadas).toBe(1);
    expect(bloqueado.html).not.toContain("rastreio.invalid");
    expect(bloqueado.html).not.toContain("/api/emails");
    expect(bloqueado.html).toContain('<a href="https://site.invalid/a" target="_blank" rel="noopener noreferrer nofollow">site</a>');
    const liberado = limparHtmlEmail(html, { imagensCid: new Map(), permitirExternas: true });
    expect(liberado.html).toContain('src="https://rastreio.invalid/pixel.gif"');
    expect(liberado.html).not.toContain("/api/emails");
    expect(politicaDoQuadro(false)).toContain("img-src data:;");
    expect(politicaDoQuadro(true)).toContain("img-src data: https: http:;");
  });

  it("mantém os estilos do Outlook (<style> do <head> e o <body>) sem título, meta nem XML do Office", () => {
    const r = limparHtmlEmail(
      `<html><head><meta name="Generator" content="Microsoft Word"><title>x</title><style>p.MsoNormal{margin:0cm;font-family:"Calibri",sans-serif}</style><xml><o:OfficeDocumentSettings/></xml></head><body lang="PT-BR" style="word-wrap:break-word" bgcolor="#ffffff"><p class="MsoNormal">Bom dia<o:p></o:p></p></body></html>`,
      { imagensCid: new Map(), permitirExternas: false },
    );
    expect(r.html).toContain('<style>p.MsoNormal{margin:0cm;font-family:"Calibri",sans-serif}</style>');
    expect(r.html).toContain('<div lang="PT-BR" style="word-wrap:break-word" bgcolor="#ffffff" class="omni-corpo"><p class="MsoNormal">Bom dia</p></div>');
    expect(r.html).not.toMatch(/<title|<meta|OfficeDocumentSettings|Generator/);
  });

  it("imagens da internet pelo proxy: <img>, atributo background e url() do CSS; url() para o Omni vira none", () => {
    const proxy = (u: string) => `/api/email/imagem?u=${encodeURIComponent(u)}`;
    const r = limparHtmlEmail(
      `<style>.topo{background:url('https://cdn.invalid/fundo.png')} .x{background-image:url(/api/whatsapp/foto/1)}</style><table background="https://cdn.invalid/t.png" style="background:url(https://cdn.invalid/s.png)"><tr><td background="/api/x"><img src="https://cdn.invalid/logo.png"></td></tr></table>`,
      { imagensCid: new Map(), permitirExternas: false, proxy },
    );
    expect(r.externasBloqueadas).toBe(0);
    expect(r.html).toContain(`url("${proxy("https://cdn.invalid/fundo.png")}")`);
    expect(r.html).toContain("background-image:none");
    expect(r.html).toContain(`background="${proxy("https://cdn.invalid/t.png").replace(/&/g, "&amp;")}"`);
    expect(r.html).toContain(`style="background:url(&quot;${proxy("https://cdn.invalid/s.png")}&quot;)"`);
    expect(r.html).toContain(`src="${proxy("https://cdn.invalid/logo.png")}"`);
    expect(r.html).not.toContain('background="/api/x"');
    expect(r.html).not.toContain("https://cdn.invalid/logo.png\"");
    expect(politicaDoQuadro(false, true)).toContain("img-src data: 'proxy';");
  });
});

