# Prompt para o Claude Code no filtroAPP — PDF dos RDOs e relatórios técnicos pela API de integração (e e-mail corporativo do colaborador)

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`.
> Escrito em 10/11/2026. Não muda nada do que o Omni e o Prisma CRM já consomem.

---

## Contexto

O Omni (`../omni`) mostra na missão as abas **RDOs** e **Relatórios**, com os dados de `GET /api/integracoes/v1/rdo/relatorios` (escopos `rdo.relatorios.read` e `rdo.relatorios.todos.read`). Os relatórios são RDO e os técnicos RTP, RLQ, RCPU, RLM, RLF e RLI.

Falta o **documento**: a equipe quer visualizar e baixar o PDF de cada relatório no Omni e, depois, enviá-lo no canal Interno ou no grupo do WhatsApp da missão.

**O que já existe:**
- **Geração:** o filtroAPP já gera o PDF de todos os tipos. Cada um vira DOCX pelos modelos e depois PDF pelo LibreOffice (`backend/src/lib/report-pdf-from-docx.js`); cada tipo tem o seu gerador em `generateReportPdfAsset` (`routes/resources/reports.js`).
- **Rota interna:** a tela já serve o PDF para quem está logado, em `GET /api/rdo/reports/:id/pdf`, e escolhe a versão certa em `getReportBasePdfDownload`, nesta ordem:
  1. PDF final assinado (`ReportVersion.finalPdfUrl`);
  2. assinado no ZapSign;
  3. enviado à mão;
  4. PDF base do aprovado;
  5. gerado ou do cache.
  - Depois, `getReportPdfDownload` junta os PDFs anexados ao relatório, em memória.
- **Download na API de integração:** já existe (`OPERATIONAL_DOWNLOADS`, `lib/api-credentials/operational-downloads.js`). Ele inclui:
  - caminho gerenciado, sem symlink e com limite de 50 MiB;
  - recorte por projeto do token;
  - cota;
  - `no-store`, `nosniff` e streaming.

**Leia antes de mudar:**
- `.specify/memory/constitution.md`;
- `docs/PADRAO_MODULO.md`;
- `docs/API_INTEGRACOES.md`;
- o catálogo em `lib/api-credentials/catalog.js` e `data-catalog.js`;
- `extended-operational-resources.js`;
- os testes `integration-expanded-api.test.js`, `api-openapi-contract.test.js` e `report-pdf-cache.test.js`.

**Siga as convenções:**
- spec nova `specs/038-<slug>` (spec-kit), branch `feat/...`;
- Zod na entrada;
- testes em `backend/test`;
- OpenAPI em `specs/015-api-token-playground/contracts/openapi.yaml`, subindo a versão;
- `npm run architecture:check`.
  - `reports.js` tem só cerca de 160 linhas de folga, então ponha a lógica em `lib/reports/`.
  - Não gere documentos fora do pdf-lib e do pipeline DOCX→PDF.

**Mudanças só aditivas:** o Prisma CRM também usa a API, e tokens existentes não ganham escopo sozinhos. Se algo for inviável, pare e me explique a alternativa.

## Pedido

### 1. Download do PDF de um relatório

- **Rota:** `GET /api/integracoes/v1/rdo/relatorios/:id/pdf`.
- **Escopo novo** `rdo.relatorios.pdf.download`:
  - depende de `rdo.relatorios.read`;
  - sensibilidade `PERSONAL`, porque o documento traz nomes e assinaturas;
  - registrado em `API_SCOPES` e `API_OPERATIONS` como as outras rotas `.download`.
- **Mesmo documento da tela:** a mesma escolha de `getReportBasePdfDownload`.
  - Se der, inclua também os PDFs anexados, como faz `getReportPdfDownload`. Para isso, crie uma variante do helper de download que envie um buffer em memória com os mesmos cuidados (limite de 50 MiB, `Content-Length`, `no-store`, `nosniff`, `Content-Disposition` com o nome do arquivo).
  - Se juntar os anexos for caro ou arriscado na API, sirva só o PDF base ou o final e documente.
- **Tempo:** a API corta o pedido em 15 s (`middleware/api-request-context.js`), e gerar um PDF pode levar até 60 s, com uma conversão por vez. Então:
  - Se o PDF já existe (final, ZapSign, manual, base do aprovado ou cache fresco): `200` com o arquivo.
  - Se ainda não existe: **não gere dentro do pedido**. Responda `409` com o código `PDF_NOT_READY` e `Retry-After`. Se for seguro, dispare a geração fora do pedido, pela mesma fila e sem passar à frente das conversões da tela, para a próxima tentativa encontrar o PDF.
- **Quem vê o quê:**
  - relatório `PENDING` ou `RETURNED` só com `rdo.relatorios.todos.read`;
  - recorte por projeto do token (`PROJECT_NOT_ALLOWED`);
  - o mesmo critério de visibilidade da listagem.
- **RDO de manutenção:** `RDO_MAINTENANCE` hoje responde 404 na rota interna, porque o documento é o PDF de cada `MaintenanceRecord`, servido por `/manutencao/anexos/:id/download`. Diga como o Omni chega a ele a partir do relatório (ver item 2). Não precisa duplicar o arquivo.

### 2. Saber se há PDF antes de baixar

Em `GET /rdo/relatorios`, campo **aditivo** em cada item, só para quem tem o escopo novo:

```json
"pdf": {
  "disponivel": true,
  "versao": "FINAL_ASSINADO | ZAPSIGN | MANUAL | BASE_APROVADO | CACHE",
  "nomeArquivo": "Missão 5719 Itaporã - RDO 147 - 09-11-2026 - segunda.pdf",
  "atualizadoEm": "2026-11-10T12:00:00Z"
}
```

- Sem PDF pronto: `disponivel: false`.
- `RDO_MAINTENANCE`: os IDs dos `MaintenanceAttachment` do tipo `DOCUMENT` ligados ao relatório, para o Omni usar o download de manutenção que já existe.

Se calcular isso na listagem for caro, prefira um campo barato (por exemplo, só se há versão final ou base) e documente o que ele cobre.

### 3. E-mail corporativo do colaborador (acesso às missões no Omni)

No Omni, uma pessoa de Operação só vê as missões a que está associada, e estar **alocado à missão no Efetivo** conta como associação. A alocação (`/efetivo/projetos/alocacoes`) traz só o `collaboratorId`, sem dado pessoal. O Omni liga o colaborador à conta pelo e-mail dos responsáveis (`/projetos/responsaveis`), mas isso só cobre quem é responsável de alguma missão.

Peço, no recurso de colaboradores que o Omni já lê (`colaboradores.operacional.read`, `/colaboradores`), um campo **aditivo** com o **e-mail corporativo** (`@filtrovali.com.br`) e/ou o `userId` do filtroAPP, quando o colaborador tiver conta.
- **Não** incluir e-mail pessoal, CPF nem outro dado de `colaboradores.pii.read`.
- Se o e-mail corporativo for considerado dado pessoal no catálogo, proponha o escopo certo (por exemplo `colaboradores.contato_corporativo.read`, sensibilidade `PERSONAL`) e diga o que eu marco no token.

### 4. Pergunta, sem implementar

`publishedReport` aceita só `status: 'APPROVED'`. Com o escopo básico, relatórios `SIGNED` somem de `/rdo/relatorios` e os anexos deles deixam de baixar. O Omni usa `rdo.relatorios.todos.read` e não é afetado, mas isso é intencional? Se não for, proponha a correção (incluir `SIGNED` como publicado) como mudança separada.

## Ao terminar

Responda com:
1. o que mudou, com o nome do escopo, as rotas, a versão do OpenAPI e a spec;
2. os resultados de `npm test` e `npm run architecture:check`;
3. um exemplo de resposta de `/rdo/relatorios` com o campo `pdf` e os códigos de erro do download (`404`, `409 PDF_NOT_READY`, `413`, `403 PROJECT_NOT_ALLOWED`);
4. o que eu preciso marcar no token do Omni (para eu atualizar `docs/integracoes/filtroapp-token.md` no Omni);
5. o campo e o escopo do item 3;
6. a resposta do item 4.
