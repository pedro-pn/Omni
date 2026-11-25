// Gera os ícones do app instalável (PWA) a partir do símbolo oficial da marca
// (public/marca/filtrovali-simbolo-white.png), sem recriar o logo: o símbolo é
// só redimensionado e posto sobre o fundo floresta (#30503a), com margem de
// segurança para ícones "maskable". Rode: node apps/web/scripts/gerar-icones.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const raiz = new URL("../public/", import.meta.url);
const FUNDO = [0x30, 0x50, 0x3a];

function lerPng(buf) {
  let p = 8, w = 0, h = 0, tipo = 0, prof = 0;
  const idat = [];
  while (p < buf.length) {
    const n = buf.readUInt32BE(p), t = buf.toString("ascii", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + n);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); prof = d[8]; tipo = d[9]; }
    if (t === "IDAT") idat.push(d);
    p += 12 + n;
  }
  if (tipo !== 6 || prof !== 8) throw new Error("esperado PNG RGBA 8 bits");
  const bruto = inflateSync(Buffer.concat(idat)), bpp = 4, linha = w * bpp, px = Buffer.alloc(h * linha);
  for (let y = 0; y < h; y++) {
    const f = bruto[y * (linha + 1)], src = bruto.subarray(y * (linha + 1) + 1, (y + 1) * (linha + 1));
    for (let x = 0; x < linha; x++) {
      const a = x >= bpp ? px[y * linha + x - bpp] : 0, b = y ? px[(y - 1) * linha + x] : 0, c = x >= bpp && y ? px[(y - 1) * linha + x - bpp] : 0;
      const pr = a + b - c, pa = Math.abs(pr - a), pb = Math.abs(pr - b), pc = Math.abs(pr - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * linha + x] = (src[x] + pred) & 255;
    }
  }
  return { w, h, px };
}

const crcTab = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTab[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function bloco(tipo, dados) {
  const t = Buffer.from(tipo, "ascii"), out = Buffer.alloc(12 + dados.length);
  out.writeUInt32BE(dados.length, 0); t.copy(out, 4); dados.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([t, dados])), 8 + dados.length);
  return out;
}
function gravarPng(arquivo, w, h, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const bruto = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) rgba.copy(bruto, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  writeFileSync(new URL(arquivo, raiz), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco("IHDR", ihdr), bloco("IDAT", deflateSync(bruto, { level: 9 })), bloco("IEND", Buffer.alloc(0))]));
}

/** Símbolo redimensionado (média por área) e centralizado sobre o fundo, ocupando `fracao` do lado. */
function icone(simbolo, lado, fracao) {
  const out = Buffer.alloc(lado * lado * 4);
  for (let i = 0; i < lado * lado; i++) out.set([...FUNDO, 255], i * 4);
  const alvo = Math.round(lado * fracao), off = Math.round((lado - alvo) / 2), escala = simbolo.w / alvo;
  for (let y = 0; y < alvo; y++) for (let x = 0; x < alvo; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = Math.floor(y * escala); sy < Math.floor((y + 1) * escala); sy++) for (let sx = Math.floor(x * escala); sx < Math.floor((x + 1) * escala); sx++) {
      const i = (sy * simbolo.w + sx) * 4, al = simbolo.px[i + 3] / 255;
      r += simbolo.px[i] * al; g += simbolo.px[i + 1] * al; b += simbolo.px[i + 2] * al; a += al; n++;
    }
    if (!n) continue;
    const al = a / n, o = ((y + off) * lado + x + off) * 4;
    for (let k = 0; k < 3; k++) out[o + k] = Math.round((a ? [r, g, b][k] / a : 0) * al + FUNDO[k] * (1 - al));
  }
  return out;
}

const simbolo = lerPng(readFileSync(new URL("marca/filtrovali-simbolo-white.png", raiz)));
for (const [arquivo, lado, fracao] of [["icones/omni-192.png", 192, 0.62], ["icones/omni-512.png", 512, 0.62], ["icones/apple-touch-icon.png", 180, 0.66]]) {
  gravarPng(arquivo, lado, lado, icone(simbolo, lado, fracao));
  console.log("gerado", arquivo);
}
