# Prompt para o Claude Code no Prisma CRM — liberar o staging do Omni no sandbox

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `crm-filtrovali`. Escrito em 05/11/2026.

---

## Contexto

O Omni vai ganhar um ambiente de **staging** em `https://omnistaging.filtrovali.com.br`, na mesma VPS, para testar com HTTPS antes da produção (`https://omni.filtrovali.com.br`). O staging roda o build de produção do Omni, mas usa **somente o sandbox do Prisma**: a validação do ambiente do Omni recusa `PRISMA_OMNI_ENVIRONMENT=production` fora da produção.

Pelo contrato `docs/prisma-omni.md` (1.66.0), a autorização individual do Omni (Authorization Code + PKCE S256, cliente `omni`) compara o `redirect_uri` **exatamente**, sem curingas. Os callbacks cadastrados hoje são:

| Ambiente | Callback |
|---|---|
| Produção | `https://omni.filtrovali.com.br/integracoes/prisma/retorno` |
| Sandbox | `http://localhost:3000/integracoes/prisma/retorno` |
| Sandbox, consumidor hospedado | `https://omni.filtrovali.com.br/integracoes/prisma/retorno` |

Com isso, no staging, "Conectar ao Prisma" falha na autorização e na troca do código.

## Pedido

1. **Cadastrar o callback do staging só no sandbox:**
   `https://omnistaging.filtrovali.com.br/integracoes/prisma/retorno`
   - Mesma regra de comparação exata (sem barra final, porta, query ou fragmento), na autorização (`/api/omni/oauth/authorize`) e na troca (`/api/omni/oauth/token`).
   - **Não** aceitar esse callback com `environment=production`: uma autorização de produção pedida pelo staging deve ser recusada como os outros callbacks não cadastrados.
   - Não mudar os callbacks existentes, os escopos, o prazo do código (5 minutos, uso único) nem a validade das credenciais (3 meses).
2. **Leitura (`reader`) a partir da VPS:** confirmar que a credencial `reader` do **sandbox** funciona quando chamada do servidor da VPS (o worker do Omni lê empresas, oportunidades, missões, eventos e as pastas do SharePoint em `/api/omni/v1/sandbox`). Se houver restrição por IP, por origem ou pelo `User-Agent` (o Omni envia `User-Agent: omni-filtrovali`), dizer o que precisa ser liberado. Não criar credencial nova sem necessidade; se for preciso, criar uma `reader` **só do sandbox**, rotulada "Omni – staging".
3. **Pergunta, sem implementar:** o corte do Foco vai fazer o Prisma chamar o Omni nos mesmos caminhos do Foco (`/api/v1/*` e `/api/prisma-authorization/*`, hoje em `foco.filtrovali.com.br`). É possível, **só no sandbox ou numa configuração de teste**, apontar a integração de tarefas para `https://omnistaging.filtrovali.com.br` e ensaiar o corte sem tocar na produção? Responder como seria (o que muda, onde fica o endereço do Foco no Prisma, se a conexão de cada pessoa precisa ser refeita) e o que impede, se houver.

## Restrições

- Produção do Prisma: nada muda (callbacks, ambientes, dados e a integração atual com o Foco).
- Seguir o padrão do projeto para alteração de configuração/migration (aditiva, sem bootstrap de dados) e atualizar `docs/prisma-omni.md` (tabela de callbacks e versão do contrato).
- Testes: autorização e troca aceitam o callback do staging no sandbox; recusam no `production`; recusam variações (barra final, query, `http://`).

## Entrega

- Versão do contrato e o que foi publicado (e se a publicação já está ativa no domínio público).
- Resposta dos itens 2 e 3.
- Como conferir: o Omni abre `https://omnistaging.filtrovali.com.br/integracoes/prisma/conectar`, consente no Prisma sandbox, volta para `/integracoes/prisma/retorno` e a troca no servidor devolve `environment: "sandbox"`.
