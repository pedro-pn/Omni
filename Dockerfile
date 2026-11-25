# Imagens do Omni. Alvos: web, worker e migrate (todos a partir do mesmo lockfile).
#   docker build --target web -t omni-web .
#   docker build --target worker -t omni-worker .
#   docker build --target migrate -t omni-migrate .

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN npm run build -w @omni/web

# ---- web: só a saída do nitro (servidor Node autocontido)
FROM node:26-alpine AS web
WORKDIR /app
# Commit publicado (deploy/publicar.sh passa); /api/saude devolve, para conferir o deploy.
ARG OMNI_VERSAO=desconhecida
ENV NODE_ENV=production PORT=3000 OMNI_VERSAO=${OMNI_VERSAO}
COPY --from=build --chown=node:node /app/apps/web/.output ./.output
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/saude >/dev/null || exit 1
CMD ["node", ".output/server/index.mjs"]

# ---- worker: roda o TypeScript com tsx
FROM deps AS worker
ARG OMNI_VERSAO=desconhecida
ENV NODE_ENV=production OMNI_VERSAO=${OMNI_VERSAO}
# ffmpeg: gravações das ligações em M4A para o SharePoint e de volta para a transcrição.
RUN apk add --no-cache ffmpeg
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
USER node
CMD ["node_modules/.bin/tsx", "apps/worker/src/main.ts"]

# ---- migrate: aplica as migrations e sai
FROM deps AS migrate
ENV NODE_ENV=production
COPY tsconfig.base.json ./
COPY packages packages
USER node
CMD ["node_modules/.bin/tsx", "packages/db/src/cli/migrate.ts"]
