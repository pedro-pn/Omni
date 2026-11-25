# Imagem experimental. Não altera a imagem nem o compose da Evolution em uso.
FROM omni-evolution:2.3.7-presence.1
COPY *.mjs /evolution/node_modules/baileys/lib/omni-chamada/
RUN node /evolution/node_modules/baileys/lib/omni-chamada/patch.mjs \
    && node --check /evolution/node_modules/baileys/lib/Socket/index.js \
    && node --check /evolution/node_modules/baileys/lib/Socket/messages-recv.js \
    && node -e 'import("/evolution/node_modules/baileys/lib/index.js").then(() => console.log("BRIDGE_MODULE_LOAD_OK"))'
LABEL com.filtrovali.experimento="chamadas-pareamento-unico-1"
