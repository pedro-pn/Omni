import { describe, expect, it } from "vitest";

import { buscarImagem, enderecoDoProxy, ImagemIndisponivel, ipBloqueado, urlAssinada } from "./email-imagem.ts";

const SEGREDO = "s".repeat(48);

describe("Proxy de imagens dos e-mails", () => {
  it("só aceita endereços assinados pelo Omni", () => {
    const e = new URL(enderecoDoProxy(SEGREDO, "https://cdn.invalid/logo.png?v=1"), "https://omni.invalid");
    expect(e.pathname).toBe("/api/email/imagem");
    expect(urlAssinada(SEGREDO, e.searchParams.get("u"), e.searchParams.get("s"))).toBe("https://cdn.invalid/logo.png?v=1");
    expect(urlAssinada("t".repeat(48), e.searchParams.get("u"), e.searchParams.get("s"))).toBeNull();
    const outra = Buffer.from("http://169.254.169.254/latest/meta-data", "utf8").toString("base64url");
    expect(urlAssinada(SEGREDO, outra, e.searchParams.get("s"))).toBeNull();
    expect(urlAssinada(SEGREDO, null, null)).toBeNull();
  });

  it("bloqueia rede interna, loopback, nuvem e reservados (IPv4, IPv6 e IPv4 dentro do IPv6)", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"])
      expect(ipBloqueado(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "142.250.79.36", "2606:4700:4700::1111"]) expect(ipBloqueado(ip), ip).toBe(false);
  });

  it("recusa antes de conectar: IP interno, porta fora de 80/443, nome local, outro protocolo", async () => {
    for (const url of ["http://127.0.0.1/x.png", "http://[::1]/x.png", "https://cdn.invalid:8080/x.png", "http://localhost/x.png", "http://servidor.local/x.png", "file:///etc/passwd", "http://user:pw@cdn.invalid/x.png"])
      await expect(buscarImagem(url), url).rejects.toBeInstanceOf(ImagemIndisponivel);
  });
});
