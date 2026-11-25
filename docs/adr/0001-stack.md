# ADR 0001 — Stack do Omni

- **Data:** 26/10/2026 · **Situação:** aceita (decisão do Otávio)

## Contexto
O CLAUDE.md original pedia a stack do Foco (TanStack Start + Supabase). O estudo mostrou que o Omni é pesado em lógica de servidor (webhooks Meta e Graph, agenda da IA, LLM, sincronização com filtroAPP, Prisma e Foco), que exige um worker Node de qualquer forma, e que o filtroAPP e o comercialAPP já operam Postgres próprio em Docker na VPS, atrás de um Caddy compartilhado.

## Decisão
- Front do Foco: **TanStack Start + React 19 + TypeScript + Tailwind 4 + shadcn/Radix**, PWA.
- Back no padrão filtroAPP/comercialAPP: **Node 24 LTS + Postgres 16 próprio com RLS**, **Drizzle** (consultas tipadas; migrations em SQL puro), **pg-boss** (fila e agenda), **login Microsoft Entra via MSAL Node** (código + PKCE, como no comercialAPP).
- Docker na VPS, atrás do Caddy do filtroAPP (`deploy/caddy/omni.caddy`, porta 8084).

## Consequências
- Permissões no banco (RLS) com três papéis: `omni_owner` (migrations), `omni_app` (web) e `omni_worker` (worker), nenhum com BYPASSRLS.
- Tempo real por SSE + `LISTEN/NOTIFY` (sem Supabase Realtime).
- Arquivos continuam no SharePoint; não há storage próprio.
- Backup e monitoramento próprios (o backup do filtroAPP não cobre outros apps).
