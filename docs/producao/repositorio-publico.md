# Auditoria para tornar o repositório público

Feita em 25/11/2026, sobre os 121 commits da `master` (todo o histórico). Motivo: com o repositório
público, o GitHub Actions não cobra, e a proteção da `master` fica disponível no plano gratuito.

**Regra:** abrir o repositório publica **todo o histórico**, não só a versão atual. Apagar um arquivo
num commit novo não basta: ele continua nos commits antigos.

## Resultado

| # | Achado | Gravidade | Onde |
|---|---|---|---|
| 1 | Prints de sistemas reais: funil comercial do Prisma (clientes, contatos, valores das propostas), acompanhamento de missão do filtroAPP (cliente, custos, avanço), assinatura de e-mail de uma pessoa e conversa de missão no WhatsApp | **Crítica** | `referencias/*.png` (no histórico desde o primeiro commit) |
| 2 | Nomes e e-mails reais de pessoas da Filtrovali (58 e-mails distintos, parte real e parte de exemplo) | Alta | `INSTRUCOES.md`, `PLANEJAMENTO.md`, `CLAUDE.md`, `prototipo/`, testes portados do Foco (`packages/core/src/tarefas/*.test.ts`), `docs/producao/`, `packages/db/src/cli` |
| 3 | Nomes de clientes reais em textos de exemplo | Alta | testes do parser em lote (`batch-task-parser.test.ts`), `INSTRUCOES.md` (números de proposta reais) |
| 4 | Identificadores do Microsoft 365: tenant, app registrations, sites e bibliotecas do SharePoint (GUIDs e `driveId`) | Média | `docs/integracoes/m365-registro.md`, `sharepoint-*.md`, `deploy/*.env.example` |
| 5 | IP da VPS e mapa da infraestrutura (portas internas, nomes de serviço, caminho dos segredos) | Média | `docs/producao/migracao-foco.md`, `deploy/`, `docs/producao/deploy.md` |
| 6 | Número de celular que parece real nos testes do serviço de voz | Média | `experiments/whatsapp-chamada/shadow_test.go`, `evolution-bridge/bridge.test.mjs` |
| 7 | Números de missão reais e detalhes de chamadas aos outros sistemas (ids de projeto do filtroAPP) | Baixa | `docs/integracoes/prompt-*.md`, `sharepoint-*.md` |
| 8 | E-mail pessoal do autor em todos os commits | Baixa | metadados do Git |
| 9 | Sem `LICENSE` (código público sem licença continua "todos os direitos reservados", mas fica ambíguo) e sem `SECURITY.md` (como avisar uma falha) | Baixa | raiz |

### O que está limpo
- **Segredos:** gitleaks 8.24 no histórico inteiro achou 4 itens, todos falsos positivos (valores de
  teste e o texto "troque-por-…" do `.env.example`). Nenhum `.env`, chave ou certificado foi commitado.
- **Workflows:** só usam `pull_request` (nunca `pull_request_target`); o único segredo
  (`OPENAI_API_KEY`, em `ia-avaliacao.yml`) não chega a PRs de fork, que só recebem o aviso.
- **Código:** a segurança não depende de o código ser secreto (RLS no banco, segredos por ambiente,
  webhooks com segredo no cabeçalho).

## Limpeza feita (25/11/2026)

Decisão: repositório novo `pedro-pn/Omni`, público, a partir da cópia limpa; o anterior virou
`omni-archive` (privado) e guarda o histórico. Sem licença (código fechado, todos os direitos reservados).

| # | O que foi feito |
|---|---|
| 1 | `referencias/` removida; as menções no INSTRUCOES descrevem o que os prints mostravam, sem dados. A foto e o telefone reais embutidos na assinatura do protótipo foram trocados (fica o avatar com iniciais). |
| 2 | Nomes e sobrenomes reais trocados por fictícios em todo o repositório, com a mesma troca em documentos, protótipo, testes e e-mails (o parser em lote continua com a mesma estrutura de nomes, e os testes passam). |
| 3 | Clientes reais da ata usada nos testes do parser trocados por fictícios. |
| 4 | GUIDs do Microsoft 365, `driveId` e o endereço do tenant no SharePoint trocados por `<GUID>`, `<driveId>` e `<tenant>`; `GRAPH_ANEXOS_DRIVE_ID` vazio nos exemplos de `.env`. |
| 5 | IP da VPS trocado por `<IP da VPS>`. |
| 6 | Celular dos testes do serviço de voz trocado por número de exemplo, mantendo a regra do nono dígito. |
| 8 | Commit inicial com o e-mail `noreply` do GitHub. |
| 9 | `SECURITY.md` criado. Sem `LICENSE`, por decisão do dono. |

## Caminho recomendado

Reescrever o histórico item por item (`git filter-repo`) deixa sobras fáceis de esquecer e muda
os 121 commits de qualquer forma. É mais seguro **publicar um repositório novo a partir de uma cópia
limpa**, com um único commit inicial, e manter o atual privado como arquivo do histórico.

1. **Limpar a versão atual** (numa branch):
   - remover `referencias/` (ou trocar por desenhos sem dados reais);
   - trocar nomes e e-mails reais por fictícios em documentos, protótipo e testes (os testes do Foco
     continuam iguais na lógica; só os nomes mudam);
   - trocar nomes de clientes reais por fictícios;
   - tirar GUIDs, `driveId`, IP e nomes de site dos documentos, deixando o nome da variável e onde
     encontrar o valor (Entra, SharePoint, `.env` da VPS);
   - trocar o celular dos testes por números de exemplo (`55 11 9xxxx`);
   - acrescentar `LICENSE` (decisão do dono) e `SECURITY.md`.
2. **Conferir de novo:** gitleaks e as buscas desta auditoria na branch limpa, sem achados.
3. **Publicar:** repositório novo, um commit com a árvore limpa, autor com o e-mail `noreply` do GitHub.
4. **Configurar:** proteção da `master` (PR, CI obrigatório, sem push direto), Dependabot,
   "aprovar workflows de colaboradores externos", segredo `OPENAI_API_KEY` só no ambiente necessário.
5. **Trocar o `origin`** na máquina de desenvolvimento e na VPS (`~/apps/Omni`) para o repositório novo.

### Dados que já passaram pelo GitHub privado
O histórico atual continua só no repositório privado. Nada precisa ser trocado (nenhum segredo vazou),
mas os prints do item 1 devem ficar fora de qualquer cópia pública ou fork.

## Como refazer as buscas

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.24.2 git /repo --no-banner --redact
git grep -ohE "[a-z0-9._-]+@filtrovali\.com\.br" | sort -u
git grep -nE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" -- docs deploy
git grep -nE "b![A-Za-z0-9_-]{20,}"
git ls-files | grep -iE "\.(png|jpe?g|pdf|xlsx?|csv)$"
```
