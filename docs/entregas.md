# Plano de maturidade: entregas E01 a E23

O Omni é medido por uma régua de 13 pilares (repositório e CI, testes, deploy e recuperação,
autenticação, CSP, contratos de API, dependências, LGPD, custos e limites, desempenho,
observabilidade e documentação). Cada lacuna virou uma **entrega**, com um PR cada, só squash e CI
verde. O acompanhamento ao vivo fica numa página de status fora do repositório; este arquivo é o
registro do que foi feito e de onde está.

**Situação:** ✅ concluída · 🟡 em andamento ou congelada (com o que falta) · Atualizado em 26/11/2026.

## Etapa 0: antes do CI

| Entrega | Pilar | Situação | O que foi feito |
|---|---|---|---|
| E01 Auditoria para tornar o repositório público | 1, 8 | ✅ | Prints, nomes, e-mails, clientes, IDs do M365 e IPs trocados por fictícios ou retirados; gitleaks sem achados. Repositório publicado com um commit só. `docs/producao/repositorio-publico.md`. |
| E02 CI de volta | 1, 2 | ✅ | Auditoria de dependências, build, typecheck e testes no GitHub Actions (`.github/workflows/ci.yml`). |
| E03 Produção no que está na master | 1 | ✅ | Publicada pelo `deploy/publicar.sh`, com a versão em `/api/saude`. |
| E04 MFA obrigatório | 4 | ✅ | Acesso Condicional do Entra exige MFA para o app Omni. |
| E05 Teto de gasto da OpenAI | 10 | ✅ | Teto em dinheiro e alerta no painel do projeto. |

## Etapa 1: bloqueios de nível 1

| Entrega | Pilar | Situação | O que foi feito |
|---|---|---|---|
| E06 Backup no B2 com ensaio de restauração | 3 | ✅ | Backup local a cada 5 h e diário no B2, com os segredos cifrados, e ensaio mensal de restauração (`docs/producao/backup.md`). Execuções automáticas conferidas e senha dos segredos no cofre da empresa em 26/11; primeiro ensaio automático em 02/12. |
| E07 Staging | 3 | ✅ | `omnistaging.filtrovali.com.br`, pasta e banco próprios, travas de fora da produção, CSP aplicando (`docs/producao/deploy.md` §3.4). |
| E08 Deploy repetível com volta | 1, 3 | 🟡 congelada | `deploy/publicar.sh` confere a saúde e volta sozinho se falhar. Falta ensaiar a volta de verdade no staging. |
| E09 Alerta de erros | 12.1 | ✅ | `system_errors` (0079), job `alertas-erros`, Administração → Erros, aviso no sino e no celular de quem é admin (testado em 26/11). |
| E10 Limite de requisições | 10.1 | ✅ | 429 com `Retry-After` nas rotas públicas e caras (`apps/web/src/server/limites.ts`). |
| E11 Teto diário da IA | 10.2 | ✅ | Gasto do dia somado no banco (0080); metade avisa, teto para a IA. |

## Etapa 2: parciais de nível 1

| Entrega | Pilar | Situação | O que foi feito |
|---|---|---|---|
| E12 CSP e Permissions-Policy | 6.5 | 🟡 congelada | CSP com nonce (`apps/web/src/server/csp.ts`). Staging bloqueando; produção em relatório. Falta passar a produção para `CSP_MODO=aplicar` depois de alguns dias sem violações. |
| E13 Dependências | 8 | ✅ | sanitize-html atualizado, Dependabot e `npm audit` no CI. |
| E14 Contrato da API e rotas públicas | 7, 8 | ✅ | `apps/web/public/openapi.json`; lista das rotas públicas com teste; rotas internas fechadas no Caddy (`docs/producao/rotas-publicas.md`). |
| E15 LGPD: retenção, RIPD e titular | 9 | ✅ | Retenção real dos dados técnicos e de negócio (0066, 0081, 0083), Baixar meus dados (0082), `titular.md`, `ripd.md`, `retencao.md`. |
| E16 CSRF | 4.3 | ✅ | Conferência de origem em toda alteração (`apps/web/src/server/csrf.ts`). |
| E17 Revisão de segurança | 8 | 🟡 congelada | `SECURITY.md` e aviso privado de falhas no GitHub. Falta a revisão de segurança registrada. |
| E23 Teste instável da cifra das gravações | 2 | ✅ | Corrigido na causa: de 1,95 s para 34 ms, sem aumentar o limite. |

## Etapa 3: repositório público

| Entrega | Pilar | Situação | O que foi feito |
|---|---|---|---|
| E18 Proteção da master e e2e no CI | 1, 2 | ✅ | Master só por PR com CI verde, histórico linear, só squash. O CI roda a bateria ponta a ponta no build de produção com a CSP bloqueando. |

## Etapa 4: nível 2

| Entrega | Pilar | Situação | O que foi feito |
|---|---|---|---|
| E19 Tempo por rota e consultas lentas | 11.1 | ✅ | `desempenho_rotas` (0084), `pg_stat_statements`, Administração → Desempenho (`docs/producao/desempenho.md`). |
| E20 Logs centrais e painel de saúde | 12.2, 12.3 | ✅ | Logs mascarados no Grafana Cloud (`deploy/logs`), rotação local e Administração → Saúde (0085, `docs/producao/logs.md`). Conferido no Grafana em 26/11. |
| E21 Registro de incidentes com causa | 12.4 | ✅ | Administração → Incidentes (0086): encerrar exige causa e correção; sem exclusão. Primeiro registro: o envio indevido de logs na ativação da E20 (PR #33). |
| E22 README, glossário e mapa de variáveis | 13 | ✅ | `README.md`, `docs/glossario.md`, `docs/variaveis.md` (com teste) e este arquivo. |

## Como uma entrega é feita

1. Branch a partir da `master`, uma entrega por PR.
2. Código, migration nova quando precisa (nunca editar uma aplicada), teste e documentação em
   `docs/` no mesmo PR. O `CLAUDE.md` ganha a linha da entrega.
3. CI verde (testes, typecheck, build, auditoria e ponta a ponta) e merge por squash.
4. Publicação no staging e na produção pelo `deploy/publicar.sh` e conferência na própria produção.
   Só então a entrega fica concluída.
5. Deu errado no caminho: registro em Administração → Incidentes, com a causa.
