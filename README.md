# Omni

Conversas, missões e tarefas da Filtrovali em uma tela só: WhatsApp, Outlook, SharePoint, Teams, Prisma CRM, tarefas e Missões com canais Interno e Gerencial e uma IA que acompanha o ciclo da missão.

- **Plano, stack e fases:** [PLANEJAMENTO.md](PLANEJAMENTO.md)
- **Produto e regras de negócio:** [INSTRUCOES.md](INSTRUCOES.md)
- **Como trabalhar no código:** [CLAUDE.md](CLAUDE.md)
- **Decisões:** [docs/adr/](docs/adr/)
- **Protótipo (especificação visual):** `npm run abrir` → http://localhost:4321

## Rodar localmente

Pré-requisitos: Node 24, Docker.

```bash
cp .env.example .env            # troque AUTH_SECRET por um valor aleatório
npm install
npm run db:up && npm run db:migrate
npm run db:seed-dev -- seu.email@filtrovali.com.br "Seu Nome"
npm run dev                     # http://localhost:3000 → "Entrar sem Microsoft"
```

Testes: `npm test` · Tipos: `npm run build && npm run typecheck`.

Prova local de chamadas WhatsApp: `npm run chamada:poc` (Go 1.27) ou `npm run chamada:docker` (Linux). Começa em modo simulado: [instruções e pareamento de teste](experiments/whatsapp-chamada/README.md).

Chamadas pessoais na interface do Omni, com gravações privadas e compartilhamento: [integração de desenvolvimento](docs/integracoes/chamadas-omni.md).

## Produção

`deploy/docker-compose.prod.yml` (Postgres, migrations, web, worker) atrás do Caddy compartilhado do filtroAPP (`deploy/caddy/omni.caddy`). Segredos em `deploy/.env.production`, nunca no repositório.
