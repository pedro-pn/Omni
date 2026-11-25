import sanitizeHtml from "sanitize-html";

/**
 * HTML de e-mail para mostrar no Omni (só servidor). O que sai daqui ainda é
 * mostrado num iframe isolado (sem scripts, CSP que só carrega o permitido),
 * mas a limpeza é a primeira barreira:
 * - só tags e atributos de formatação (tabelas, fontes, cores, links, imagens);
 *   nada de script, formulário, iframe, objeto, evento (on*) ou javascript:;
 * - mantém os estilos do e-mail (<style> do <head>, onde o Outlook põe MsoNormal,
 *   fontes e margens, e o estilo do <body>), para ficar como no Outlook;
 * - imagens embutidas (cid:, a assinatura) viram data: com o anexo do próprio e-mail;
 * - imagens da internet (no <img>, no atributo background e no url() do CSS) passam
 *   pelo proxy do Omni (`proxy`), como no Outlook na web: o remetente não vê o IP nem
 *   o navegador de quem abre. Sem proxy, ficam bloqueadas até a pessoa liberar;
 * - url() do CSS que não é da internet nem data: vira "none" (nada aponta para o Omni);
 * - links abrem em outra aba, sem passar o Omni como origem.
 */

export type ResultadoHtml = { html: string; externasBloqueadas: number };

const TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  "img", "font", "center", "u", "s", "strike", "style", "span", "div", "small", "big", "sub", "sup", "hr", "br", "colgroup", "col", "caption",
];
const ATRIBUTOS_GERAIS = [
  "style", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "dir", "lang", "title",
  "class", "id", "span", "background", "nowrap", "bordercolor", "frame", "rules", "hspace", "vspace", "clear", "size", "noshade", "start", "type", "scope",
];

const IMAGEM_DATA = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;

/** Troca todo url(...) do CSS: da internet → proxy; imagem data: → mantém; o resto → none. */
function urlsDoCss(css: string, proxy: ((url: string) => string) | undefined, contar: () => void): string {
  return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_tudo, _aspas: string, alvo: string) => {
    const url = alvo.trim();
    if (IMAGEM_DATA.test(url)) return `url("${url}")`;
    if (/^https?:\/\//i.test(url)) {
      if (proxy) return `url("${proxy(url)}")`;
      contar();
    }
    return "none";
  });
}

export function limparHtmlEmail(
  html: string,
  opcoes: { imagensCid: Map<string, string>; permitirExternas: boolean; proxy?: (url: string) => string },
): ResultadoHtml {
  let externasBloqueadas = 0;
  const contar = () => (externasBloqueadas += 1);
  // Com proxy, as imagens da internet aparecem sempre; sem ele, só se a pessoa liberar.
  const proxy = opcoes.proxy ?? (opcoes.permitirExternas ? (u: string) => u : undefined);
  const imagemExterna = (url: string) => (proxy ? proxy(url) : (contar(), null));
  // O texto dos <style> passa direto pelo sanitize-html (sem textFilter): os url() são trocados antes.
  const comCss = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_t, abre: string, css: string, fecha: string) => abre + urlsDoCss(css, proxy, contar) + fecha);
  const limpo = sanitizeHtml(comCss, {
    allowedTags: TAGS,
    // <style> do Outlook (MsoNormal etc.): sem scripts no iframe, CSS não executa nada;
    // a CSP do iframe impede que um url() carregue algo além do proxy.
    allowVulnerableTags: true,
    allowedAttributes: {
      "*": ATRIBUTOS_GERAIS,
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height", "data-omni-externa"],
      font: ["face", "size", "color"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data", "https", "http", "cid"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    // O <head> some, mas o que há dentro dele continua (os <style>); título, meta e o XML do Office, não.
    nonTextTags: ["script", "noscript", "textarea", "option", "title", "xml", "o:p"],
    exclusiveFilter: (frame) => frame.tag === "style" && !frame.text.trim(),
    transformTags: {
      // O <body> vira um bloco com o mesmo estilo e cor de fundo.
      body: (_tag, attribs) => ({ tagName: "div", attribs: { ...attribs, class: `${attribs.class ?? ""} omni-corpo`.trim() } }),
      a: (_tag, attribs) => {
        const href = attribs.href ?? "";
        const ok = /^(https?:|mailto:|tel:)/i.test(href);
        return { tagName: "a", attribs: { ...(ok ? { href } : {}), target: "_blank", rel: "noopener noreferrer nofollow" } };
      },
      img: (_tag, attribs) => {
        const src = (attribs.src ?? "").trim();
        const { src: _src, ...resto } = attribs;
        if (/^cid:/i.test(src)) {
          const dados = opcoes.imagensCid.get(src.slice(4).replace(/^<|>$/g, "").toLowerCase());
          return { tagName: "img", attribs: dados ? { ...resto, src: dados } : resto };
        }
        if (IMAGEM_DATA.test(src)) return { tagName: "img", attribs: { ...resto, src } };
        if (/^https?:\/\//i.test(src)) {
          const via = imagemExterna(src);
          return { tagName: "img", attribs: via ? { ...resto, src: via } : { ...resto, "data-omni-externa": "1" } };
        }
        // Relativo, javascript:, file: etc.: sem imagem.
        return { tagName: "img", attribs: resto };
      },
      "*": (tagName, attribs) => {
        const novos = { ...attribs };
        if (novos.style) novos.style = urlsDoCss(novos.style, proxy, contar);
        if (novos.background !== undefined) {
          const b = novos.background.trim();
          const via = /^https?:\/\//i.test(b) ? imagemExterna(b) : null;
          if (via) novos.background = via;
          else delete novos.background;
        }
        return { tagName, attribs: novos };
      },
    },
  });
  return { html: limpo, externasBloqueadas };
}

/** Caminho do proxy de imagens do e-mail (a tela troca 'self' por ele com a origem do Omni). */
export const CAMINHO_PROXY_IMAGEM = "/api/email/imagem";

/**
 * CSP do documento do iframe: nada de script nem conexão. Imagens: data: e, com o
 * proxy, só o caminho dele (`'proxy'` é trocado na tela pela origem do Omni +
 * CAMINHO_PROXY_IMAGEM); sem proxy, as da internet só se liberadas.
 */
export function politicaDoQuadro(permitirExternas: boolean, comProxy = false): string {
  const imagens = comProxy ? " 'proxy'" : permitirExternas ? " https: http:" : "";
  return `default-src 'none'; img-src data:${imagens}; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'`;
}
