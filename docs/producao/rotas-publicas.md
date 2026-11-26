# Rotas públicas e contratos

Entrega E14 (pilares 7 e 8). O que responde sem a sessão de quem está logado, quem chama, qual credencial confere e onde está o contrato.

## Regra

- **Tudo exige sessão**, menos as rotas desta página. Telas, server functions e as demais rotas de `/api` conferem a sessão (`personIdFromRequest`) e o aceite do termo, e os dados passam pelo RLS com a identidade da pessoa.
- A lista oficial fica em `apps/web/src/server/rotas-publicas.ts`. O teste `rotas-publicas.test.ts` lê os arquivos de rota e **falha**:
  - se uma rota sem sessão não estiver na lista;
  - se os métodos não forem os da lista;
  - se uma rota com sessão escapar da conferência de origem (`DE_SERVIDOR` em `csrf.ts`);
  - se uma rota interna não estiver fechada no Caddy.
- Rota pública nova: entra na lista com quem chama e a credencial, tem limite de requisições (`packages/core/src/limites.ts`) e, se for chamada por servidor, entra em `DE_SERVIDOR`.

## Lista

| Rota | Métodos | Quem chama | Credencial | Exposição |
|---|---|---|---|---|
| `/api/saude` | GET | publicar.sh, healthcheck, monitoramento | nenhuma (só status, banco e versão) | internet |
| `/api/csp-relatorio` | POST | navegador | nenhuma; até 16 KB, guarda só diretiva e origem | internet |
| `/api/v1/*` | GET, POST, PATCH, DELETE, OPTIONS | Prisma e automações | chave pessoal Bearer com escopos (`/health` e `/openapi.json` sem chave) | internet |
| `/api/prisma-authorization/token` | POST | servidor do Prisma | código de uso único (5 min) + PKCE S256 | internet |
| `/api/prisma-authorization/revoke` | POST | servidor do Prisma | a própria chave no corpo | internet |
| `/api/calendar/apple/feed/<link>.ics` | GET | apps de agenda | link privado assinado | internet |
| `/api/graph/avisos` | POST | Microsoft Graph | `clientState` da assinatura | internet |
| `/api/whatsapp/webhook` | POST | Evolution (`http://web:3000`) | segredo no cabeçalho | **interna** |
| `/api/chamadas/eventos` | POST | serviço de voz (`http://web:3000`) | chave Bearer | **interna** |
| `/auth/microsoft`, `/auth/callback` | GET | navegador (login Microsoft) | state, nonce e PKCE em cookie selado | internet |
| `/auth/dev` | POST | navegador | recusada fora do desenvolvimento | internet |
| `/auth/sair` | POST | navegador | mesma origem; encerra só o próprio cookie | internet |

Também são públicos os arquivos de `apps/web/public` (marca, ícones, áudio, `manifest.webmanifest`, `sw.js`, `openapi.json`) e os `/assets` do build. Nenhum traz dado de ninguém.

## Rotas internas fechadas no Caddy

O webhook da Evolution e os eventos do serviço de voz só são chamados pela rede do Docker. Mesmo com credencial própria, não precisam ficar abertos para a internet.

`deploy/caddy/omni.caddy` responde 404 para eles, nos blocos da produção e do staging:

```
@interno path /api/whatsapp/webhook /api/chamadas/eventos
handle @interno {
	respond 404
}
```

**Aplicar na VPS:** o Caddyfile em uso é o do proxy compartilhado (`filtroAPP-main/deploy/infra-proxy`). Copie o trecho para os dois blocos do Omni e recarregue o Caddy. Depois confira:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://omni.filtrovali.com.br/api/whatsapp/webhook   # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://omni.filtrovali.com.br/api/chamadas/eventos   # 404
```

Na própria VPS, a Evolution continua chegando: ela usa `http://web:3000`, que não passa pelo Caddy.

## Contratos

- **API de tarefas e autorização do Prisma:** `apps/web/public/openapi.json` (OpenAPI 3.1), servido em `/openapi.json` e em `/api/v1/openapi.json`. Traz:
  - as rotas de `/api/v1`, compatíveis com o Foco;
  - a troca e a revogação em `/api/prisma-authorization/*`;
  - o passo do consentimento no navegador (`/?integracao=prisma&…`), descrito em `info.description`.
- **O que o Omni consome:**
  - filtroAPP: escopos em `docs/integracoes/filtroapp-token.md`;
  - Prisma: contrato 1.67.0, cliente em `@omni/integrations/prisma`;
  - Graph: `docs/integracoes/m365-registro.md`.
