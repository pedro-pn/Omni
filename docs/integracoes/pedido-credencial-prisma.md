# Pedido ao desenvolvedor do Prisma CRM — integração com o Omni

> Texto para enviar ao responsável pelo Prisma. Escrito em 26/10/2026 a partir de `crm-filtrovali/docs/prisma-personal-api.md`, `prisma-personal-api-v2.md`, `prisma-filtroapp.md` e `prisma-missions.md`.

---

Olá! Estamos começando o **Omni**, o app que vai juntar WhatsApp, Outlook, SharePoint, Teams, tarefas (o Foco será absorvido por ele) e as Missões numa tela só. O Prisma continua sendo o dono de oportunidades, contatos pessoa, contatos CNPJ, feedbacks e número da missão. O Omni só lê e grava pelo Prisma, sem duplicar a verdade.

Precisamos de acesso de **integração de aplicação** (não de uma chave pessoal), no mesmo espírito do contrato com o FiltroAPP: tokens por finalidade, guardados só como hash, com ambiente (`sandbox` e `production`), revogação, expiração opcional e auditoria.

## 1. Leitura (token `reader` do Omni — servidor a servidor)

Usado pelo worker do Omni para manter um cache de leitura. O Omni aplica as próprias regras de visibilidade (oportunidades e valores só para diretoria, vendas, marketing e supervisores).

| Recurso | Campos que precisamos | Filtros |
|---|---|---|
| Contatos pessoa | id, nome, cargo, e-mails, telefones (normalizados E.164), empresa(s), dono (`ownerId`), origem, tags, `updatedAt`, `deletedAt` | `updated_since`, busca por telefone / e-mail |
| Contatos CNPJ (empresas) | id, nome, **CNPJ (`taxId`)**, segmento, cidade/UF, dono, domínios de e-mail (se houver), `updatedAt`, `deletedAt` | `updated_since`, busca por CNPJ |
| Oportunidades | id, **código público** (`MMNNNN/AAAA` / código da proposta), título, funil, etapa, status (open/won/lost…), temperatura, valor, serviço, dono/vendedor, contato principal, empresa, **stakeholders**, prazo/fechamento previsto, ID da missão, `updatedAt` | `updated_since`, por empresa, por contato, por status |
| Histórico / feedbacks | por oportunidade, contato e empresa: texto, autor, data, menções, contato positivo | por entidade, `updated_since` |
| Missões | número (4 dígitos), nome, oportunidades vinculadas, empresa, situação | `updated_since` |
| Usuários do CRM | id, nome, **e-mail corporativo**, papel/equipe, ativo | — (para casar dono/vendedor com a pessoa no Omni) |
| Funis e etapas | ids, nomes, ordem, probabilidade | — |

Requisitos: paginação por cursor estável, `updated_since` em tudo, sinal de exclusão (`deletedAt` ou feed de remoções), limites claros (req/min e linhas/dia) e resposta com `requestId`.

## 2. Eventos (para o Omni não depender só de polling)

Feed `GET /events?cursor=` (preferível) ou webhook com assinatura HMAC, com pelo menos:
- oportunidade **ganha** / perdida / reaberta / mudou de etapa;
- missão criada ou oportunidade vinculada a missão;
- contato pessoa ou empresa criado / alterado / mesclado / excluído.

## 3. Escrita em nome da pessoa (autoria correta)

Feedbacks e contatos gravados pelo Omni precisam aparecer no Prisma **com o autor real** (quem clicou "Registrar no Prisma"), respeitando as permissões dessa pessoa no CRM. Duas formas possíveis — escolha a que for mais simples e segura para o Prisma:

- **A (preferida):** autorização por usuário com Authorization Code + PKCE S256 (o mesmo modelo que o Foco já oferece ao Prisma), gerando credencial individual revogável só com os escopos abaixo.
  - Cliente fixo `omni`.
  - URIs de retorno **exatas** (comparação literal, sem curingas):
    - produção: `https://omni.filtrovali.com.br/integracoes/prisma/retorno`;
    - desenvolvimento: `http://localhost:3000/integracoes/prisma/retorno`.
  - `code` e `state` voltam no **fragmento** (`#code=…&state=…`), como no fluxo Foco→Prisma. A página do Omni lê o fragmento, apaga-o da barra de endereço e faz a troca do código no servidor, com o verificador PKCE.
- **B (alternativa):** token `producer` do Omni + cabeçalho com o e-mail Entra do usuário que agiu, validado pelo Prisma contra um membro ativo, aplicando as permissões dele.

Ações necessárias:

| Ação | Hoje | O que falta |
|---|---|---|
| Registrar **feedback / histórico** vinculado ao mesmo tempo a **oportunidade + contato pessoa + contato CNPJ** (tipo: feedback do cliente, histórico de atividade, ocorrência), com data real do evento e origem (`whatsapp`, `email`, `ligação`, `reunião`) + link de volta ao Omni | `note` grava em **uma** entidade por vez | Uma chamada com vários vínculos, idempotente |
| **Upsert de contato pessoa** por e-mail ou telefone (nome, cargo, empresa) | buscar + POST/PATCH | Upsert idempotente, com regra de mesclagem |
| **Upsert de empresa** por CNPJ | `taxId` não sai na v1 | Upsert por CNPJ |
| **Vincular participante externo à missão** (contato do cliente detectado em e-mail/WhatsApp da missão) | não existe | Rota nova; terceiros (hotel, transportadora, fornecedor) **não** serão enviados ao Prisma |
| Registrar em lote (ex.: "Registrar conversa no Prisma" com N mensagens) | — | Lote com resultado por item |

Todas as escritas com `Idempotency-Key` (UUID), e `If-Match` onde houver revisão — como já é no Prisma.

## 4. Mudanças previstas que afetam o Prisma (para planejar, não para agora)

1. **Tarefas:** o Foco será migrado para dentro do Omni e depois desligado. No dia do corte, a integração atual do Prisma com o Foco (leitura de tarefas + autorização PKCE) deve passar a apontar para o Omni. O Omni vai manter o mesmo contrato `/api/v1` do Foco para facilitar.
2. **WhatsApp:** no início, os números de vendas continuam no Atendimento do Prisma e o Omni usa números de operação (cada número em um sistema só). Mais adiante, todos os números serão unificados no Omni, pela Cloud API oficial; nessa fase o Prisma passará a ler conversas/feedbacks do Omni.

## 5. O que pedimos de volta

- Credenciais de **sandbox** primeiro (reader + a forma de escrita escolhida), depois produção.
- Documentação/OpenAPI das rotas novas e das existentes que usaremos.
- Limites de uso e o contato para incidentes.
- Prazo estimado para os itens das seções 2 e 3.

Obrigado!
