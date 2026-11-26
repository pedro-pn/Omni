# Evolution do Omni: mesma versão e mesmo patch da Evolution do Prisma
# (copiados de crm-filtrovali/infra/whatsapp/evolution em 05/11/2026; ver README.md).
# O patch evita que o Baileys anuncie presença em atualizações parciais de
# credencial, o que tirava as notificações do celular do dono do número.
FROM evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339
# CVE-2026-48063 (Baileys < 7.0.0-rc12): a trava da correção aplicada no rc.9.
COPY patch-cve-2026-48063.mjs cve-2026-48063.test.mjs /tmp/omni-cve/
RUN node /tmp/omni-cve/patch-cve-2026-48063.mjs \
    && node --check /evolution/node_modules/baileys/lib/Utils/process-message.js \
    && node /tmp/omni-cve/cve-2026-48063.test.mjs \
    && rm -r /tmp/omni-cve
COPY patch-presence.mjs presence.test.mjs /tmp/omni-presence/
RUN node /tmp/omni-presence/patch-presence.mjs \
    && node --check /evolution/node_modules/baileys/lib/Socket/socket.js \
    && node /tmp/omni-presence/presence.test.mjs \
    && rm -r /tmp/omni-presence
# Nome da agenda do celular nos contatos que já existiam (o Omni mostrava só o número).
COPY patch-contatos.mjs contatos.test.mjs /tmp/omni-contatos/
RUN node /tmp/omni-contatos/patch-contatos.mjs \
    && node --check /evolution/dist/main.mjs \
    && node /tmp/omni-contatos/contatos.test.mjs \
    && rm -r /tmp/omni-contatos
# Liga o @lid ao número na lista de contatos (nome da agenda nas conversas que chegam pelo @lid).
COPY patch-lid.mjs lid.test.mjs /tmp/omni-lid/
RUN node /tmp/omni-lid/patch-lid.mjs \
    && node --check /evolution/dist/main.mjs \
    && node /tmp/omni-lid/lid.test.mjs \
    && rm -r /tmp/omni-lid
LABEL com.filtrovali.patch="baileys-partial-credential-presence-1"
LABEL com.filtrovali.patch-contatos="evolution-contact-names-1"
LABEL com.filtrovali.patch-lid="evolution-lid-mapping-1"
LABEL com.filtrovali.app="omni"
# Trava do Omni: não sobe sem chave geral forte nem sem senha do banco (o compose
# de produção não pode exigir as variáveis fora do perfil "whatsapp").
ENTRYPOINT ["/bin/bash", "-c", "if [ ${#AUTHENTICATION_API_KEY} -lt 32 ]; then echo 'AUTHENTICATION_API_KEY ausente ou curta (mínimo 32)'; exit 1; fi; case \"$DATABASE_CONNECTION_URI\" in *evolution:@*) echo 'senha do banco da Evolution ausente'; exit 1;; esac; . ./Docker/scripts/deploy_database.sh && npm run start:prod"]
