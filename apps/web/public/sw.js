/*
 * Service worker do Omni (app instalável). Só notificações: não guarda páginas
 * nem dados em cache (o Omni sempre lê do servidor, com a permissão de quem
 * está logado). O conteúdo do push chega cifrado e vem do worker do Omni.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    dados = {};
  }
  const titulo = typeof dados.titulo === "string" ? dados.titulo : "Omni";
  // Só endereços do próprio Omni.
  const url = typeof dados.url === "string" && dados.url.startsWith("/") && !dados.url.startsWith("//") ? dados.url : "/";
  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: typeof dados.corpo === "string" ? dados.corpo : "",
      icon: "/icones/omni-192.png",
      badge: "/icones/omni-192.png",
      tag: typeof dados.tag === "string" ? dados.tag : undefined,
      renotify: Boolean(dados.tag),
      lang: "pt-BR",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const abertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const omni = abertas.find((c) => new URL(c.url).origin === self.location.origin);
      if (omni) {
        await omni.focus();
        omni.postMessage({ tipo: "abrir", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// Inscrição trocada pelo navegador: avisa a página aberta para inscrever de novo.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage({ tipo: "reinscrever" }))),
  );
});
