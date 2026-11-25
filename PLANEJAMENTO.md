# Omni — Planejamento de implementação e stack

> Versão 1 · 26/10/2026 · Base: `INSTRUCOES.md` (protótipo v24), `prototipo/`, e estudo dos sistemas vizinhos em `../filtroAPP-main`, `../crm-filtrovali` (Prisma CRM) e `../comercialAPP`.
>
> O **Omni** é o nome definitivo da "Central Filtrovali" descrita em `INSTRUCOES.md`. Este documento **não substitui** o INSTRUCOES: ele revisa o plano à luz do que já existe nos outros sistemas, define a stack e organiza a implementação.

---

## Sumário

1. [Resumo executivo](#1-resumo-executivo)
2. [O que o estudo mudou no plano](#2-o-que-o-estudo-mudou-no-plano)
3. [Decisões em aberto do INSTRUCOES: situação](#3-decisões-em-aberto-do-instrucoes-situação)
4. [Papel do Omni no ecossistema](#4-papel-do-omni-no-ecossistema)
5. [Stack](#5-stack)
6. [Arquitetura](#6-arquitetura)
7. [Modelo de dados revisto](#7-modelo-de-dados-revisto)
8. [Plano de implementação por fases](#8-plano-de-implementação-por-fases)
9. [Trabalho necessário nos outros sistemas](#9-trabalho-necessário-nos-outros-sistemas)
10. [Segurança e LGPD](#10-segurança-e-lgpd)
11. [Qualidade de engenharia](#11-qualidade-de-engenharia)
12. [Riscos](#12-riscos)
13. [Perguntas para o Otávio](#13-perguntas-para-o-otavio)

---

## 1. Resumo executivo

- **O Omni é a camada de comunicação e de IA**, não um novo sistema de gestão. A missão, as etapas, os RDOs, a qualidade, o romaneio, o efetivo e os custos **já existem no filtroAPP**; oportunidades, contatos e número da missão **já existem no Prisma CRM**. O Omni lê esses dados, conversa sobre eles e escreve de volta pelas APIs — nunca mantém uma cópia própria da verdade.
- **O que é só do Omni:** conversas e mensagens (WhatsApp, e-mail, chamadas, notas), canais Interno e Gerencial com corte de histórico, vínculo de e-mails às missões, participantes externos, agenda e estado da IA, alertas personalizados, inbox zero e auditoria de acesso.
- **Stack recomendada:** TanStack Start + React 19 + TypeScript + Tailwind 4 no front (mesma do Foco), com **Node 24 LTS + Postgres 16 próprio com RLS, Drizzle, pg-boss e login Microsoft Entra (MSAL)**, em Docker na VPS da Filtrovali atrás do Caddy já existente — o mesmo padrão operacional do filtroAPP e do comercialAPP. Supabase fica como alternativa (seção 5).
- **O Foco será absorvido pelo Omni** (decisão do Otávio, 26/10/2026): as tarefas passam a ser um módulo do Omni, os dados são migrados e só então o Foco é desligado. Como o front do Omni usa a mesma base do Foco, a interface e as regras (parsers, recorrência) são portadas, não reescritas (Fase 3).
- **Ordem de entrega muda:** WhatsApp (maior dependência externa: Meta, números, coexistência, sobreposição com o Prisma) vai para depois. Primeiro entram as **Missões com canais Interno/Gerencial alimentadas pelo filtroAPP** — que atende o objetivo declarado ("o time usa o sistema; a diretoria vê tudo") —, as **Tarefas (migração do Foco)** e o **Microsoft 365**.
- **Há trabalho fora do Omni:** o filtroAPP precisa de eventos de saída, liberação de escopos da API e algumas escritas (ex.: abrir desvio); o Prisma precisa de rotas para feedback com múltiplos vínculos e upsert de contatos. Isso entra no cronograma (seção 9).
- **Decidido em 26/10/2026:** stack com Postgres próprio (Opção B); visibilidade das conversas de clientes por combinação de regras; WhatsApp **separado no início** (Prisma fica com os números de vendas, Omni começa com números de operação) e **unificado no Omni depois**; **nenhum nome de pessoa fixo no código** — quem recebe cada aviso é uma função configurável (seção 4.1).

---

## 2. O que o estudo mudou no plano

| # | Descoberta | Onde | Impacto no Omni |
|---|---|---|---|
| 1 | **Fluxo completo da missão já existe** no filtroAPP: 11 etapas com gates, checklists por etapa, papéis por área e nelson D-90/30/15/7/1 (specs 016–032, todas concluídas). | `filtroAPP-main/shared/schemas/project-workflow.js`, `backend/src/lib/efetivo/project-workflow/rules.js` | As 13 etapas do protótipo são substituídas pelas do filtroAPP. O Omni **exibe e comenta**, não recria. A IA pergunta sobre o que os checklists do filtroAPP ainda não cobrem. |
| 2 | Missão = `Project.code` no filtroAPP (número de 4 dígitos). O Prisma gera o número ao ganhar a oportunidade (`drax_app.missions`, último ~5846) e entrega o projeto ao filtroAPP pela API de integrações. | `crm-filtrovali/docs/prisma-missions.md`, `filtroAPP-main/docs/PRISMACRM_OPORTUNIDADES.md` | Chave da missão no Omni: `code` + `filtroapp_project_id` + `prisma_mission_id`. |
| 3 | Papéis: líder de projetos = `ProjectWorkflow.leaderUserId`; gestor de contrato = `plannerUserId`; líder de campo = `Project.operatorId`. **Não existem** como campo: vendedor (só texto), responsável pela documentação, coordenador de mobilização. | schema do filtroAPP | O Omni lê os três existentes; os demais precisam ser criados no filtroAPP (preferível) ou guardados no Omni temporariamente. |
| 4 | API de integrações do filtroAPP (`/api/integracoes/v1`) com tokens por escopo, cursor estável e `updatedSince`. Já expõe RDOs, serviços, relatórios técnicos, Qualidade, equipamentos e status do projeto. **Bloqueados hoje:** custos, Omie, ponto, romaneio, alocações, diretório de usuários. **Sem webhooks de saída.** Só relatórios `APPROVED` aparecem. | `filtroAPP-main/docs/API_INTEGRACOES.md` | Fase de Gestão depende de liberar escopos. Para a IA reagir rápido (RDO novo, "sem avanço"), precisa de eventos de saída — ou polling a cada poucos minutos como solução inicial. |
| 5 | **Prisma CRM já tem uma central de Atendimento** com WhatsApp (Meta oficial + **Evolution por QR code**, que espelha o WhatsApp Web), linhas com responsável/atendentes, grupos por oportunidade ganha, Outlook por usuário (OAuth PKCE) e API pessoal v1/v2. | `crm-filtrovali/docs/prisma-whatsapp-*.md`, `docs/prisma-outlook.md`, `docs/prisma-personal-api*.md` | **Sobreposição direta** com as Conversas do Omni. Precisa de decisão de fronteira (seção 13). A Evolution conflita com a regra do Omni de usar só a Cloud API. |
| 6 | Login Microsoft: **só o comercialAPP tem SSO Entra em produção** (MSAL Node, código + PKCE, certificado, tenant único com atribuição obrigatória). filtroAPP usa login local; o Prisma tem o código, mas desligado. | `comercialAPP/backend/src/auth/microsoft.js`, `docs/MICROSOFT_LOGIN.md` | Reaproveitar o padrão do comercialAPP. O Omni precisa de **um app Entra próprio** com permissões Graph (o do filtroAPP só tem SMTP). |
| 7 | Feriados: o calendário corporativo do filtroAPP já calcula nacionais **incluindo Carnaval (seg e ter)**, Paixão e Corpus Christi; não tem municipais de Itajaí. | `filtroAPP-main/backend/src/lib/calendar/corporate-calendar.js` | Alinhar o calendário útil da IA ao do filtroAPP e acrescentar a tabela de municipais (Itajaí). |
| 8 | Qualidade no filtroAPP: tipos Desvio, Incidente, Reclamação do cliente, Melhoria, Lição aprendida; numeração `D-001/26`; responsável (`actionOwner`) é texto livre; **o módulo não notifica ninguém**; não há tipo "NC" (só texto em `linkedRnc`). | `shared/schemas/qualidade.js` | "Todo não vira desvio" → o Omni abre o registro **no filtroAPP** (precisa de rota de escrita) e faz a notificação. |
| 9 | Metas semanais já existem (`MissionWeeklyProgressTarget`) em `PCT_POINTS`, `M`, `L`, `UN`, `COLLABORATORS`, e revisão semanal da execução com 7 verificações. | `backend/src/lib/acompanhamento/weekly-progress-targets.js`, `shared/schemas/project-execution.js` | A "Revisão semanal" do protótipo deve espelhar esses dados; responde a decisão em aberto nº 7. |
| 10 | Proposta (comercialAPP) traz jornada, dias de viagem, prazos de integração/execução/mob-desmob, stand-by e horas previstas. O filtroAPP guarda `includesSaturday/Sunday` e `workdayHours`. | `comercialAPP/shared/comercial`, `filtroAPP-main/backend/src/lib/overtime.js` | "Trabalho fora do regime" tem base de dados; os campos de regime precisam entrar na projeção `/projetos` da API. |
| 10b | **"Multa" de equipamento em obra = condição de stand-by da proposta.** A proposta tem "Prazo previsto de permanência em obra (dias corridos)" (`n_dias`) e a tabela "Condições de Stand by e Mobilização Adicional" com **diária de stand-by de equipamentos** (`diaria_equipamento`), além de stand-by de equipe e mobilização adicional. O texto da cláusula vem da configuração privada do comercialAPP. O filtroAPP já importa `CommercialProposal.plannedDays` e `components.diariaEquipamento`. "Multa" propriamente dita só existe em locação (atraso). | `comercialAPP/shared/comercial/src/modelo-documento.ts` (`tabelaStandby`, `prazos.permanencia`), `filtroAPP-main/backend/src/lib/acompanhamento/access-import.js` | O alerta de "equipamento em obra" usa: dias corridos desde a descarga × permanência prevista; ao estourar, mostra a diária de stand-by de equipamentos. Precisa expor esses campos na API do filtroAPP. |
| 11 | **Não existe em lugar nenhum:** confirmação de chegada/descarga do equipamento no cliente, parcial × total de equipamento, transportadora, CT-e, data de viagem da equipe separada da mobilização, etapa financeira após o encerramento, validade de ASO/NR por colaborador (Solides, que está sendo substituído por sistema próprio). NF de saída está no Omie. | — | Ou o Omni cria esses registros (via perguntas da IA), ou o filtroAPP ganha os campos. Recomendação: **campos no filtroAPP**, perguntas no Omni. |
| 12 | **Foco** (cópia em `../foco/foco`): TanStack Start 1.168 + React 19 + Tailwind 4 + shadcn/Radix + Poppins, feito no Lovable, banco **Supabase na nuvem**, login Microsoft (provedor Azure do Supabase, com senha como alternativa), testes com `bun test`. API `/api/v1` completa (projetos, tarefas com criar/editar/fechar/reabrir, seções, comentários, atividade) com chave pessoal Bearer, implementada numa RPC SQL (`foco_api_request`). Parsers `batch-task-parser.ts` (381 linhas) e `smart-parse.ts` (521) são **TypeScript puro, sem dependências**. Não há webhooks de saída. Já existe autorização por usuário com PKCE (cliente `prisma`, só leitura). | `foco/src/server/foco-public-api.ts`, `public/openapi.json`, `docs/prisma-authorization.md`, `src/features/foco/` | **O Foco será absorvido pelo Omni** (Fase 3): portar parsers, recorrência e telas; migrar os dados das 36 tabelas; manter a API `/api/v1` compatível para o Prisma; desligar o Foco depois. ⚠️ A cópia tem um `.env` — não versionar nem redistribuir. |
| 13 | Ecossistema de IA: filtroAPP usa OpenAI (só "Adequar texto"); Prisma usa Cloudflare Workers AI (classificar e-mails). | `filtroAPP-main/docs/ADEQUAR_ANOTACOES.md` | O Omni usa a **API da OpenAI** (decisão de 03/11/2026, ADR 0005). Entrar na ROPA como operador novo. |
| 14 | Siglas dos relatórios técnicos (confirmadas pelo Otávio em 26/10/2026): **RTP** Teste de Pressão · **RLQ** Limpeza Química · **RCPU** Contagem de Partículas e Umidade · **RLM** Limpeza Mecânica · **RLF** Flushing · **RLI** Inibição. | — | O README do filtroAPP está desatualizado em RTP e RCPU (corrigir lá). |

---

## 3. Decisões em aberto do INSTRUCOES: situação

| # (seção 16) | Tema | Situação | Resposta / próximo passo |
|---|---|---|---|
| 1 | Etapas da missão | ✅ Resolvido | Usar as 11 etapas do filtroAPP: Handover comercial → Análise inicial → Aguardando planejamento → Planejamento da mobilização (D-30) → Preparação (D-15) → Mobilização → Execução → Desmobilização → Pós-job → Documentação/medição → Encerrado. Depois de "Encerrado", o Omni acompanha o financeiro (NF emitida → aguardando pagamentos → missão terminada) a partir do Omie. |
| 2 | Siglas dos relatórios | ✅ Resolvido | Ver item 14 acima. |
| 3 | Carnaval | ✅ Resolvido (proposta) | Seguir o filtroAPP: segunda e terça de Carnaval **não** recebem mensagens da IA. Um calendário só para a empresa. |
| 4 | Responsável da Qualidade e da documentação | ✅ Resolvido | Sem nomes no código. Viram **funções** configuráveis (seção 4.1), preenchidas a partir dos papéis do filtroAPP (`QUALIDADE_MANAGER`, `EFETIVO_ADMINISTRATIVE`) ou de grupos do Entra. |
| 5 | "Data prevista de atendimento" × "previsão de mobilização" | ✅ Resolvido | São diferentes no filtroAPP: `commercialExpectedMobilizationDate`, `commercialExpectedStartDate` e `ClientRelease.attendanceDate`. A IA não pede o que já foi preenchido. |
| 6 | Terceiros (hotel, fornecedores) no Prisma | ✅ Resolvido | Contatos **do cliente** detectados nos e-mails/WhatsApp da missão vão para o Prisma; **terceiros ficam só no Omni** (confirmado em 26/10/2026). |
| 7 | Unidade da meta semanal | ✅ Resolvido | `%`, metros, litros, unidades ou colaboradores, por serviço (filtroAPP). |
| 8 | Situação dos 20+ números de WhatsApp | 🟡 Parcial | Decidido: separado no início (vendas no Prisma, operação no Omni), unificado no Omni depois. Falta o inventário completo dos números (Fase 0). |
| 9 | API do Prisma | ✅ Resolvido (com lacunas) | API pessoal v1/v2 (`/api/v1`, chave `prisma_pk_…`, `If-Match` + `Idempotency-Key`). Lacunas na seção 9. |
| 10 | Onde nascem romaneios e NF/CT-e de transporte | ✅ Resolvido | Romaneio nasce no filtroAPP. NF e CT-e ficam no Omie (o espelho do filtroAPP precisa passar a trazer o CT-e). Quem confirma a **descarga** na obra é o **Líder de Projetos** da missão (`leaderUserId`) — o planejador que acompanha o projeto; "planejador" e "líder de projetos" são a mesma função (confirmado pelo Otávio em 26/10/2026). |
| 11 | Origem dos RDOs e do sistema de acompanhamento | ✅ Resolvido | Ambos são o filtroAPP. |
| 12 | Multa de equipamentos | ✅ Resolvido | Permanência prevista em obra (dias corridos) + diária de stand-by de equipamentos, ambas da proposta do comercialAPP (item 10b da seção 2). |
| 13 | Assinaturas de e-mail e selos ISO/GPTW | ❓ Perguntar (baixa prioridade) | — |
| 14 | Quem vê as conversas de clientes | ❓ Perguntar | Proposta na seção 13. |

---

## 4. Papel do Omni no ecossistema

```
                        ┌──────────────────────── Microsoft 365 ────────────────────────┐
                        │  Entra ID (login+MFA) · Outlook · SharePoint · Teams (Graph)  │
                        └───────────────────────────────┬───────────────────────────────┘
                                                        │
 ┌──────────────┐  oportunidade, contato,     ┌─────────┴─────────┐   missão, etapas, RDO,     ┌──────────────┐
 │  Prisma CRM  │◄── feedback, nº missão ────►│       OMNI        │◄── qualidade, romaneio, ──►│  filtroAPP   │
 │ (vendas)     │                             │ conversas · canais│    efetivo, custos, Omie   │ (operação)   │
 └──────┬───────┘                             │ IA · inbox zero   │                            └──────┬───────┘
        │ ganho → projeto                     └───┬───────────┬───┘                                   │
        └──────────────────────────────────────────┼───────────┼───────────────────────────────────────┘
                                                   │           │              proposta, escopo, horas
                                    tarefas ┌──────┴──┐   ┌────┴─────────────┐  (comercialAPP → filtroAPP)
                                            │  Foco   │   │ WhatsApp Cloud   │
                                            └─────────┘   │ API (Meta)       │
                                                          └──────────────────┘
```

**Fonte da verdade por assunto**

| Assunto | Dono | O Omni… |
|---|---|---|
| Missão, etapas, checklists, gates, papéis | filtroAPP | lê; pede ao usuário e grava pela API quando houver rota |
| RDO, relatórios técnicos, assinaturas | filtroAPP | lê; cobra o líder de campo |
| Desvios, incidentes, NC, lições | filtroAPP (Qualidade) | **abre** registros (rota nova) e notifica |
| Romaneio, equipamentos, estoque | filtroAPP | lê |
| Efetivo, alocações, ausências, feriados | filtroAPP | lê |
| Custos, Omie, faturamento, ponto/HH | filtroAPP | lê (escopos a liberar) |
| Proposta, regime, dias de viagem, horas previstas | comercialAPP → filtroAPP | lê pelo filtroAPP |
| Oportunidade, contato pessoa, contato CNPJ, feedback | Prisma CRM | lê; registra feedback; cria/atualiza contatos |
| Número da missão | Prisma CRM (gera) → filtroAPP (`Project.code`) | usa como chave |
| Tarefas | **Omni** (após a migração do Foco na Fase 3; até lá, Foco) | é o dono; expõe `/api/v1` compatível com o Foco para o Prisma |
| Arquivos | SharePoint | referencia e faz proxy com checagem de permissão |
| E-mails, reuniões, transcrições | Microsoft 365 | indexa, vincula à missão, envia |
| **Conversas, mensagens, canais Interno/Gerencial, membros e corte de histórico, vínculo e-mail↔missão, participantes, agenda e estado da IA, alertas personalizados, inbox zero, tarefas, auditoria de acesso** | **Omni** | é o dono |

Regra de ouro: **nenhum dado de negócio do filtroAPP/Prisma é editado no Omni sem passar pela API do dono.** O Omni guarda só um cache de leitura (com `synced_at`) para montar telas e alimentar a IA.

### 4.1 Funções em vez de nomes

O INSTRUCOES cita pessoas pelo nome (Sérgio mede, Priscila fatura, Gilmar é o gerente comercial, Rosana/Valéria conduzem a mobilização, "Débora" da Qualidade). **Nenhum desses nomes entra no código.** A IA e as notificações sempre endereçam uma **função**; quem ocupa a função é configuração.

| Função | Para que a IA usa | De onde vem quem ocupa |
|---|---|---|
| Qualidade | recebe todo desvio aberto pela IA | papel `QUALIDADE_MANAGER` no filtroAPP, ou grupo do Entra |
| Documentação | pergunta/avisa sobre documentos de colaboradores e liberação no cliente | papel `EFETIVO_ADMINISTRATIVE` no filtroAPP, ou grupo do Entra |
| Coordenação de mobilização | conduz equipe e equipamentos na mobilização | configuração do Omni (lista), escolhida por missão |
| Líder de Projetos *(papel da missão)* | confirma descarga do equipamento; recebe as perguntas da IA | filtroAPP (`leaderUserId`) por missão |
| Gestor de Contrato *(papel da missão)* | recebe desvios para ciência | filtroAPP (`plannerUserId`) por missão |
| Medição | mede o término dos serviços | configuração do Omni |
| Faturamento | emite NF e fecha no Omie | configuração do Omni |
| Gerente comercial | recebe saldo não medido | configuração do Omni |
| Diretoria | define quem entra no Gerencial; vê tudo | perfil no Omni |

Regras:
- Tabelas `functions` e `function_assignments` (pessoa, função, vigência, substituto nas férias/ausências).
- Papéis **da missão** (líder de projetos, gestor do contrato, líder de campo) vêm do filtroAPP por missão; papéis **da empresa** (tabela acima) vêm da configuração.
- Se a função não tiver ninguém, a IA não fica muda: avisa a diretoria no sino que a função está vaga.
- Trocar uma pessoa de função é uma alteração de configuração, sem deploy.

---

## 5. Stack

### 5.1 O que existe hoje na Filtrovali

| App | Front | Back | Banco | Login | Hospedagem |
|---|---|---|---|---|---|
| filtroAPP | React 19 + Vite + TanStack Query + Zustand | Express 5 + Prisma ORM 7 + worker | Postgres 16 (Docker) | local (usuário/senha) | VPS, Docker, Caddy |
| comercialAPP | React + Vite | Express 5 + Prisma ORM | Postgres 16 (Docker) | **Entra ID (MSAL Node)** | VPS, Docker, Caddy |
| Prisma CRM | React 19 + Vite | gateway Node + Supabase **auto-hospedado** | Postgres (Supabase) | GoTrue (e-mail/senha) | VPS (túnel Cloudflare) |
| Foco | TanStack Start + React 19 + Tailwind 4 + shadcn | TanStack Start + RPC SQL | Supabase (nuvem, via Lovable) | Microsoft (Azure no Supabase) + senha | `foco.filtrovali.com.br` |

### 5.2 Opções

**Opção A — "Stack do Foco" (o que está no CLAUDE.md):** TanStack Start + Supabase (Postgres, RLS, Realtime, Auth com provedor Azure, Storage, Edge Functions + cron).
- ➕ RLS e Realtime prontos; login Microsoft pelo GoTrue; mesmo modelo do Foco/Prisma.
- ➖ O Omni é pesado em lógica de servidor (webhooks Meta e Graph, renovação de subscriptions, agenda da IA, chamadas ao LLM, sincronização com 4 APIs). Edge Functions (Deno) não bastam: **vai precisar de um worker Node de qualquer jeito**.
- ➖ Supabase auto-hospedado são ~8 serviços para operar (o Prisma já paga esse custo); na nuvem, os dados ficam fora da VPS da empresa (há região São Paulo).
- ➖ Storage não é necessário (arquivos ficam no SharePoint).

**Opção B — "Ecossistema Filtrovali" (escolhida pelo Otávio em 26/10/2026):** mesmo front do Foco, back no padrão filtroAPP/comercialAPP.

**Opção C — Express + Vite SPA idêntico ao filtroAPP.** Máximo de consistência com o filtroAPP, mas abre mão do front do Foco (que o CLAUDE.md pede para reaproveitar) e de SSR/server functions. Não recomendada.

### 5.3 Stack recomendada (Opção B)

| Camada | Escolha | Por quê |
|---|---|---|
| Linguagem | **TypeScript** em tudo, Node 24 LTS (o filtroAPP usa 22; ambos LTS) | Um só idioma de front, back e worker; tipos compartilhados. |
| Front + servidor web | **TanStack Start** (React 19, TanStack Router/Query) | Mesma base do Foco (reaproveitar componentes e padrões); server functions para BFF; SSR leve na primeira tela. |
| Estilo | **Tailwind 4** + tokens de `identidade-visual/design-system/tokens.json` como CSS variables (claro/escuro) | Pedido do CLAUDE.md; o filtroAPP já usa Tailwind 4 com tokens. |
| Componentes | **shadcn/ui** (Radix) + `lucide-react`, Poppins via `@fontsource/poppins` | Mesmo conjunto do Foco (dá para copiar componentes); guia da marca pede ícones de traço estilo Lucide; fonte local, sem depender do Google Fonts. |
| Lista longa / timeline | TanStack Virtual | Conversas e timelines grandes. |
| Validação | **Zod** (schemas compartilhados front/back/worker) | Mesmo padrão do filtroAPP (`shared/schemas`). |
| Banco | **Postgres 16** próprio, em Docker | Mesma operação do filtroAPP; dados na VPS da empresa. |
| Segurança de dados | **RLS do Postgres** com `set_config('app.user_id', …)` por transação; role da aplicação **sem** `BYPASSRLS` | Exigência do INSTRUCOES (permissões no banco, nunca só no front). |
| ORM / migrations | **Drizzle ORM** + drizzle-kit (políticas RLS versionadas como código) | SQL-first, bom com RLS e `LISTEN/NOTIFY`; evita a confusão de nomes com o Prisma CRM. Alternativa aceitável: Prisma ORM 7 (mesmo do filtroAPP). |
| Filas e agenda | **pg-boss** (fila sobre o próprio Postgres: `run_at`, retry, cron, singleton) | A agenda da IA é "uma linha com `run_at`"; sem Redis a mais. |
| Tempo real | **SSE** + `LISTEN/NOTIFY` do Postgres | Timeline e badges ao vivo sem serviço extra; WebSocket só se precisar. |
| Login | **Microsoft Entra ID** via MSAL Node (código + PKCE + certificado), cookie de sessão httpOnly; **MFA por Acesso Condicional** no tenant; app com "atribuição obrigatória" | Padrão já validado no comercialAPP; ninguém tem senha no Omni; desligou no AD, perdeu acesso. |
| Microsoft 365 | **Microsoft Graph** (`@microsoft/microsoft-graph-client`) com permissões de aplicação restritas por *Application Access Policy* + subscriptions (webhooks) | E-mails de todas as caixas ligadas à missão, SharePoint, Teams. |
| WhatsApp | **Evolution** com pareamento por QR code (decisão de 03/11/2026, ADR 0004), atrás de uma interface do Omni; webhook autenticado | Risco de banimento aceito; um número banido pode migrar para a Cloud API pela mesma interface. |
| IA | **API da OpenAI (GPT)** — decisão de 03/11/2026, ADR 0005. SDK `openai`, chamada de ferramentas + saída estruturada; modelos por variável de ambiente, escolhidos pelo conjunto de avaliação | Respostas por botão **não** passam pelo LLM. |
| Transcrição | Transcrições do Teams via Graph; áudio próprio (chamadas) via serviço STT com região Brasil (ex.: Azure AI Speech) | Dados no Brasil quando possível. |
| PWA | `vite-plugin-pwa` (Workbox) + Web Push | Celular primeiro como PWA; app nativo depois (Expo ou Capacitor). |
| Testes | **Vitest** (unidade/integração), **Playwright** (e2e, já usado no protótipo e no filtroAPP), testes de RLS no banco real | Ver seção 11. |
| Logs e erros | pino (JSON, `requestId`, sem corpo nem tokens) + webhook de erros no mesmo padrão do filtroAPP | Regras de log da LGPD já usadas no filtroAPP. |
| Deploy | Docker Compose na VPS da Filtrovali, atrás do **Caddy compartilhado** (`deploy/infra-proxy` do filtroAPP), `omni.filtrovali.com.br` + homologação com IP restrito | Padrão do RUNBOOK do filtroAPP (Docker rootless, porta interna, `mem_limit`). |
| Backup | pg_dump próprio + envio ao Backblaze B2, com status JSON monitorado | O backup do filtroAPP **não cobre** outros apps. |
| CI | GitHub Actions: typecheck, lint, Vitest, migrations em Postgres 16, testes de RLS, build da imagem | Mesmo modelo do filtroAPP. |

Se a escolha for a **Opção A**, mudam só três linhas: banco/RLS/Realtime/Auth passam a ser do Supabase, e o pg-boss vira `pg_cron` + tabela de jobs + worker Node. Todo o restante do plano vale igual.

---

## 6. Arquitetura

```
                 Internet
                    │
             Caddy (TLS, compartilhado)
                    │
      ┌─────────────┼──────────────────────────────┐
      │       omni-web (TanStack Start)            │  ← telas, server functions, SSE,
      │       /hooks/meta  /hooks/graph            │    webhooks de entrada (validados e
      │                                            │    enfileirados, nunca processados inline)
      └───────┬──────────────────────┬─────────────┘
              │ SQL (RLS)            │ enqueue
      ┌───────┴──────────┐   ┌───────┴────────────────────────────────────┐
      │  Postgres 16     │◄──┤  omni-worker (Node)                        │
      │  dados + pg-boss │   │  • sincronização filtroAPP / Prisma / Foco │
      │  + LISTEN/NOTIFY │   │  • ingestão de e-mails e WhatsApp          │
      └──────────────────┘   │  • renovação de subscriptions do Graph     │
                             │  • agenda da IA (calendário útil)          │
                             │  • chamadas ao LLM (fila com limite)       │
                             │  • outbox: escritas em sistemas externos   │
                             └────────────────────────────────────────────┘
```

Padrões que valem para o projeto inteiro:

1. **Webhook entra, fila processa.** Toda entrada externa é validada (assinatura Meta, `clientState` do Graph), gravada em `inbound_events` com chave de idempotência e processada pelo worker.
2. **Outbox para escrever fora.** Escritas no filtroAPP, Prisma, Foco, Graph e Meta passam por `outbox` com `Idempotency-Key`, retry exponencial e status visível no item da timeline ("enviando", "enviado", "falhou — tentar de novo").
3. **Adaptadores por sistema** (`packages/integrations/<sistema>`) com interface única, cliente gerado a partir do OpenAPI quando houver (filtroAPP tem `openapi.yaml`), modo *sandbox* e testes de contrato.
4. **Sincronização incremental** com cursor por recurso (`sync_cursors`) e reconciliação completa periódica para recursos sem `updatedAt` ou sem sinal de exclusão.
5. **Calendário útil num lugar só** (`packages/core/business-calendar`): portar `nextSlot`, `prevBiz`, `bizOnOrAfter` do protótipo, mesmas regras de feriado do filtroAPP + tabela de municipais; testado com casos de borda (sexta 17h55, véspera de feriado, Carnaval).
6. **Motor da IA = máquina de estados determinística + LLM só para texto livre.** Cada fluxo da seção 7 do INSTRUCOES vira uma definição (`flow`, `state`, transições, perguntas, `run_at` calculado). Botões gravam direto no estado. O LLM entra para: interpretar `@IA`/`/alerta`, ler RDO em texto livre, detectar "chegamos", extrair nome/cargo de assinaturas, resumir chamadas.
7. **Permissão no banco.** Toda consulta de usuário roda em transação com `app.user_id`; políticas RLS por conversa, missão, canal e `history_since`. O worker usa um papel separado e explícito.
8. **"Ver como"** implementado executando a mesma consulta com o `app.user_id` da pessoa (só leitura, auditado), garantindo que mostra exatamente o que o RLS libera.

Estrutura de repositório sugerida (monorepo npm workspaces):

```
omni/
├── apps/
│   ├── web/                 # TanStack Start (telas, server functions, SSE, webhooks)
│   └── worker/              # jobs pg-boss, sincronizações, IA
├── packages/
│   ├── db/                  # schema Drizzle, migrations SQL, políticas RLS, seeds
│   ├── core/                # regras de negócio puras (calendário útil, vínculo e-mail↔missão, fluxos da IA)
│   ├── integrations/        # filtroapp, prisma, foco, graph, whatsapp, openai
│   ├── ui/                  # componentes e tokens da marca
│   └── shared/              # schemas Zod e tipos
├── prototipo/               # especificação visual (mantida)
├── identidade-visual/
├── docs/                    # ADRs, runbooks, contratos
└── deploy/                  # compose, Caddy snippet, backup
```

---

## 7. Modelo de dados revisto

Comparado à seção 12 do INSTRUCOES, saem do Omni as tabelas cuja verdade está em outro sistema (`mission_stages_log`, `mission_crew`, `rdos`, `technical_reports`, `romaneios`, `measurements`, `invoices`, `costs`, `hh_snapshots`, `weekly_goals`, `deviations`…). Elas viram **cache de leitura** (`ext_*`) ou são buscadas sob demanda.

**Identidade e acesso**
- `people` — colaborador interno (e-mail Entra como chave, `entra_oid`, cargo, nível `diretoria|gerente|…`, flags vendedor/supervisor, `filtroapp_user_id`, `filtroapp_collaborator_id`, `prisma_user_id`, `foco_user_id`, assinatura de e-mail, ativo).
- `roles` / `person_roles` — perfis do Omni (diretoria, gerente, líder de projetos, vendas, marketing, operação).
- `audit_log` — imutável (quem viu, enviou, baixou, compartilhou, "ver como", abriu e-mail de outra caixa).

**Empresas, contatos e linhas**
- `companies` — cache do Prisma (`prisma_company_id`, CNPJ, domínios de e-mail, segmento).
- `contacts` — cache do Prisma + detectados (`prisma_contact_id`, origem, empresa, telefones/e-mails normalizados).
- `whatsapp_lines` — números (`phone_number_id` da Meta, rótulo, situação, atendentes).

**Conversas**
- `conversations` — tipo `person|wa_group|mission`, empresa, contato, linha, missão.
- `conversation_user_state` — por pessoa: lida até, concluída em (inbox zero), fixada, silenciada.
- `messages` — canal `wa|email|call|meet|note|internal|managerial|ai|event|stage`, direção, autor, texto, metadados, `external_id`, `prisma_synced_at`; particionável por mês.
- `attachments` — referência (SharePoint `driveItem`, mídia Meta, `.eml`), nunca o binário quando houver fonte.
- `emails` + `email_mission_links` (motivo do vínculo, regra, confiança) · `calls` (gravação, transcrição, resumo, tarefas sugeridas).

**Missões (camada do Omni)**
- `missions` — `code`, `filtroapp_project_id`, `prisma_mission_id`, empresa, grupo do WhatsApp, configurações (avisos de tarefa no grupo etc.).
- `mission_members` — pessoa, canal `internal|managerial`, `history_since`, quem adicionou.
- `mission_roles_extra` — **temporário**: vendedor, responsável pela documentação e coordenador de mobilização enquanto o filtroAPP não tiver esses campos.
- `mission_participants` — externos detectados (fonte, cliente/terceiro, `prisma_synced_at`).
- `ext_project_snapshot`, `ext_rdo`, `ext_quality_record`, `ext_romaneio`… — cache de leitura do filtroAPP com `synced_at`.

**IA**
- `functions` / `function_assignments` — funções da empresa e quem as ocupa (seção 4.1).

**Tarefas (vindas do Foco, Fase 3)**
- `task_workspaces`, `task_folders`, `task_projects` (+ `mission_id` opcional), `task_project_members`, `task_sections`, `tasks` (recorrência, lembretes, prioridade, responsável), `task_comments` (+ menções e reações), `task_attachments` (referência ao SharePoint), `task_saved_filters`, `task_activity`, `api_keys`, `calendar_connections`. Toda linha migrada guarda `foco_id`.
- `ai_flows` (missão, fluxo, estado, payload), `ai_questions` (pergunta, destinatário, `run_at`, motivo da data, resposta, respondido por), `alert_rules` (fonte, condição, janela, destinatário, canal, repetição — saída estruturada do LLM) e `alert_events`, `ai_learned_patterns` ("veio mas você não encontrou").
- `llm_calls` — metadados para auditoria (modelo, tokens, finalidade, ids dos dados enviados) **sem** o texto completo por padrão.

**Infraestrutura**
- `holidays` (data, escopo nacional/municipal, cidade), `notifications`, `inbound_events`, `outbox`, `sync_cursors`.

---

## 8. Plano de implementação por fases

Tamanho: **P** ≈ 1–2 semanas · **M** ≈ 3–4 semanas · **G** ≈ 5–8 semanas (uma pessoa com Claude Code; ajustar após a Fase 1).

| Fase | Entrega | Tamanho |
|---|---|---|
| 0 | Decisões e acessos | P |
| 1 | Fundação | M |
| 2 | Missões com canais Interno e Gerencial | M |
| 3 | Tarefas no Omni + migração do Foco | G |
| 4 | Microsoft 365 | G |
| 5 | IA v1 (ciclo da missão, sem LLM) | M |
| 6 | Prisma | M |
| 7 | WhatsApp pela Evolution (números de operação) | G |
| 8 | IA v2 (com LLM) | M |
| 9 | Gestão e revisão semanal | M |
| 10 | Unificação do WhatsApp | M |
| 11 | Endurecimento e app | M |

### Situação conferida na produção em 16/11/2026

Produção na versão mais recente (`a506818`, 63 migrations), 2 pessoas no piloto (termo aceito). As anotações "Estado em…" das fases abaixo são históricas; esta lista vale sobre elas.

**Funcionando na produção (com uso real):**
- filtroAPP: 87 missões (41 ativas), 1.937 RDOs (o último hoje), Entrega B, Gestão (custos, semanas), eventos — todas as sincronizações sem erro (o token voltou a funcionar).
- IA do ciclo: 35 perguntas (33 publicadas no Interno), leitura dos RDOs, assinaturas e resumos ligados; 65 chamadas à OpenAI em 7 dias, nenhuma com erro.
- E-mails da missão: 2.336 e-mails ligados, o último hoje (pela caixa que tem acesso).
- Prisma em produção (ativado em 12/11): 1.933 empresas (com domínios), 820 pastas, 77 missões ligadas.
- WhatsApp: 2 números conectados, 637 conversas, 3.903 mensagens, histórico no aparelho.
- **Ligações:** 9 na produção (6 atendidas, 4 gravadas), as 4 gravações cifradas no SharePoint, 2 resumidas e 1 transcrita.
- Pessoas pelo Entra, termo de uso, feriados (10).

**Ligado, mas ainda sem uso:** Interno/Gerencial por pessoas (só mensagens da IA), Tarefas (3), notificações no celular (nenhum aparelho), conexão individual ao Prisma (ninguém), alertas pedidos à IA (nenhum), envio pelo WhatsApp pelo Omni (as respostas saíram pelo celular), funções da empresa (nenhuma pessoa atribuída: a IA não tem a quem endereçar).

**Problemas encontrados:**
- **Sem backup do Omni na produção:** o backup da VPS é do filtroAPP; não há cópia do banco do Omni (nem das chaves das gravações, sem as quais as gravações não podem mais ser ouvidas). `deploy/backup.sh` precisa entrar no cron do root.
- Uma das 2 caixas de e-mail sem acesso ("Omni - Caixas" no Exchange); a mesma impede a leitura da agenda (Teams).
- Teams: nenhuma reunião ligada a missão ainda; transcrição não testada com reunião real.
- `EMAIL_ENVIO=ensaio` (nenhum e-mail enviado pelo Omni); `EMAIL_AVISOS_REMETENTE` e `APPLE_CALENDAR_SIGNING_KEY` vazios (avisos de tarefas por e-mail e agenda .ics desligados); `WHATSAPP_EVOLUTION_DB_URL` sobrando (não é mais usada).

**Falta implementar (do plano):** checklist da etapa no painel; arquivos no Interno/Gerencial; migração do Foco (aguarda acesso) e anexos/conversa de projeto; @menção e anexo no e-mail, anexar e-mail na conversa, marcar como lido, aviso imediato por subscriptions; fluxo de criação da missão na IA e previsão pelo CT-e (depende do filtroAPP); feedback em lote no Prisma; avaliação da IA no CI; composição do avanço por serviço e faturamento/desvios na aba Gestão; Fase 10 (unificação do WhatsApp); Fase 11 (alertas de risco, retenção por tipo de dado, revisão de RLS por terceiro, teste de carga, plano de incidentes, e2e do app, liberação por módulo); provedor de conformidade (checklists do filtroAPP até a API do app de documentação).

### Fase 0 — Decisões e acessos (P)
- Responder o que falta da seção 13.
- Acessos: tenant Entra (app novo do Omni), Meta Business Manager (WABA), token da API do filtroAPP (escopos de leitura atuais), chave da API pessoal do Prisma, **acesso de leitura ao banco do Foco** (projeto Supabase do Lovable) para a migração.
- Inventário dos 20+ números de WhatsApp (dono, app × API, onde estão conectados hoje).
- Inventário de paridade do Foco (seção 8, Fase 3) e de **quem consome a API do Foco** (Prisma, chaves pessoais, automações).
- Girar as chaves do Supabase do `.env` do Foco (pendência do INSTRUCOES).
- ADRs curtos em `docs/adr/`: stack, fronteira com o Prisma, fonte da verdade da missão, absorção do Foco.
- **Pronto quando:** decisões registradas, acessos de homologação em mãos.

### Fase 1 — Fundação (M)
- Monorepo, CI, Docker Compose, homologação na VPS atrás do Caddy, backup.
- Login Entra (padrão do comercialAPP), `people` sincronizado do Entra + vínculo com usuários do filtroAPP, do Prisma e do Foco (por e-mail).
- Base de RLS + testes de RLS no CI; `audit_log`.
- Funções configuráveis (seção 4.1) e tela de administração.
- Casca da interface portada do protótipo: trilho, lista, conversa, painel; mobile (uma tela por vez, `visualViewport`); tema claro/escuro; tokens da marca; logos dos arquivos.
- Calendário útil + tabela de feriados (com testes).
- **Pronto quando:** um colaborador entra com a conta Microsoft (MFA), vê a casca vazia no computador e no celular, e os testes de RLS passam.

### Fase 2 — Missões com canais Interno e Gerencial (M)
- Sincronização do filtroAPP: projetos/missões, etapa, responsáveis, status (`/efetivo/projetos/{id}/status`), RDOs, relatórios técnicos por tipo, Qualidade.
- Lista "Missões" agrupada por cliente com etapa atual; cabeçalho e abas Tudo · Interno · Gerencial · RDOs · Relatórios.
- **Canais Interno e Gerencial** com membros, corte de histórico ("todo o histórico" × "a partir de agora"), "ver como", registro de entradas e saídas.
- Painel da missão: responsáveis, etapa e checklist (leitura, link para o filtroAPP para editar), equipe.
- Inbox zero (concluir, deslizar, reabrir com novidade de outros), sino de avisos, tempo real.
- **Pronto quando:** a equipe interna de uma missão piloto conversa só pelo Omni e a diretoria acompanha pelo Gerencial.

### Fase 3 — Tarefas no Omni + migração do Foco (G)

O Foco deixa de existir e passa a ser o módulo **Tarefas** do Omni. Primeiro migra, depois desliga. Como o front do Omni usa a mesma base do Foco (TanStack Start + React 19 + Tailwind 4 + shadcn), boa parte da interface e das regras é **portada**, não reescrita. O que muda é a camada de dados (Supabase → Postgres do Omni) e o login (Supabase Auth → Entra).

Por que nesta posição: evita construir uma integração com a API do Foco que seria jogada fora, e coloca o Omni no uso diário de todo mundo cedo (o Foco já é aberto todo dia).

**3.1 Paridade e mapeamento** — o Foco tem cerca de 32 mil linhas de TypeScript e 36 tabelas. Mapear cada uma:

| Foco | No Omni |
|---|---|
| `workspaces`, `workspace_members`, `folders`, `projects`, `project_members`, `sections`, `project_preferences`, `saved_filters` | módulo Tarefas (mesma estrutura); projeto do Foco com número de missão fica **ligado à missão** |
| `tasks` (+ recorrência, lembretes, prioridade p1–p4, responsável) | tarefas do Omni; tarefas de missão aparecem também no painel da missão |
| `comments`, `comment_mentions`, `comment_reactions` | comentários de tarefa |
| `project_messages`, `project_message_mentions` | conversa do projeto; se o projeto for de missão, avaliar unir ao canal Interno |
| `attachments` (Supabase Storage `foco-attachments`) | biblioteca de documentos do SharePoint dedicada ao Omni, via Graph (mantém a regra "arquivos no SharePoint") |
| `notifications`, `user_notification_settings`, `project_notification_preferences`, resumos semanais, lembretes por e-mail (Resend) | sino do Omni + e-mail pelo Microsoft 365 + push do PWA |
| `google_calendar_*`, `apple_calendar_feeds` | mesma função no Omni; usuários **reconectam** o Google; feeds Apple antigos redirecionados |
| `api_keys`, `activity_log`, `/api/v1` (OpenAPI) | **API compatível** no Omni (mesmo contrato `/api/v1`), para não quebrar o Prisma e automações |
| `prisma_authorization_*` (PKCE do Prisma) | mesmo fluxo no Omni; o Prisma passa a apontar para o Omni |
| `invitations`, `access_requests`, `members`, `pending_project_members`, `project_departures` | substituídos pelo login Entra + membros de projeto |

**3.2 Portar**
- `smart-parse.ts`, `batch-task-parser.ts` e `recurrence.ts` (TypeScript puro) com os testes, em `packages/core/src/tarefas/` (feito em 29/10/2026; só anotações de tipo, sem mudar comportamento).
- Componentes de tela (shadcn) e fluxos de tarefas, lote, filtros e calendário.
- Políticas RLS do Foco adaptadas (`auth.uid()` → `current_setting('app.user_id')`).
- API `/api/v1` compatível (mesmo OpenAPI, versão anotada) e autorização PKCE — feito em 29/10/2026 (rotas, campos e erros do Foco; chaves `foco_live_` com hash SHA-256; consentimento em `/?integracao=prisma`, links `/?task=ID`).

**3.3 Migração de dados**
- Script idempotente e repetível: lê o Postgres do Foco (papel só leitura) → transforma → grava no Omni, guardando o id de origem (`foco_id`) em cada linha.
- **Tarefas mantêm o mesmo id do Foco** (não só o `foco_id`): o Prisma guarda vínculos tarefa ↔ oportunidade pelo id. Chaves de API migram pelo hash (mesmo SHA-256). Na importação, desligar os triggers de histórico e de avisos (senão viram "Criou a tarefa" e avisos em massa) e trazer o histórico do Foco.
- Usuários: `auth.users` do Supabase casados com `people` pelo e-mail Entra; relatório de quem não casou.
- Anexos copiados do Storage para o SharePoint, com verificação de hash — **etapa própria**, no **site dedicado aos anexos do Omni/Foco** (`https://<tenant>.sharepoint.com/sites/OmniAnexos`, biblioteca Documentos; `Write` só nele, conferido em 04/11/2026). Não se mistura com a leitura dos documentos comerciais (Fase 4).
- Chaves pessoais da API: se o hash do Foco for compatível, migrar os hashes; senão, cada pessoa gera uma chave nova (avisar os donos de automações).
- Validação: contagem e hash por tabela e por usuário, amostragem manual, ensaio completo em homologação antes do corte.

**3.4 Corte e desligamento**
1. Piloto: um grupo usa as Tarefas do Omni com dados importados (Foco ainda é a verdade).
2. Congelar novidades no Foco (só correções) a partir do início da fase.
3. Dia do corte: Foco em **somente leitura**, carga final do delta, e `foco.filtrovali.com.br` passa a chegar ao Omni pelo Caddy — proxy em `/api/v1/*` e `/api/prisma-authorization/*`, redirecionamento 308 no resto (o proxy nas telas quebraria o login). Passo a passo e pendências (feeds Apple, logo dos e-mails, agendamentos do Supabase) em `docs/producao/entrada-em-producao.md`. Comunicado ao time.
4. Foco somente leitura por **30 dias** (consulta e conferência).
5. Exportação final arquivada no backup com retenção definida; revogar chaves; encerrar o projeto Supabase e o Lovable.

**Pronto quando:** todos os usuários do Foco trabalham no Omni, o Prisma lê tarefas do Omni, as contagens batem e o Foco está desligado.

### Fase 4 — Microsoft 365 (G)
- Outlook: leitura por contato e por missão (Graph + subscriptions), regras de vínculo (número no assunto/texto, códigos citados, domínio do cliente), "motivo do vínculo", thread, "Comentar no interno".
- Envio: Para/Cc/Cco com autocompletar, @menção, anexar e-mail, assinatura por pessoa, envio em nome do próprio usuário.
- SharePoint — **documentos comerciais (só leitura)**: pastas de oportunidades e missões **criadas e vinculadas pelo Prisma**; o Omni consome os vínculos (`sharepointFolders`, contrato Prisma 1.66.0 — **entregue em 03/11/2026**, `crm-filtrovali` PR #58) por `driveId` + `folderId`, nunca pelo nome do cliente, navega e baixa pelo servidor com a permissão de cada pessoa. Site real: `https://<tenant>.sharepoint.com/sites/arquivosfiltrovali` ("Arquivos Filtrovali", pasta "6 - DEPARTAMENTO COMERCIAL"; concessão `Read` conferida em 04/11/2026). Concessão restrita em 04/11/2026 à pasta "6 - DEPARTAMENTO COMERCIAL / A Propostas" (`ListItems.SelectedOperations.Selected`); o app não lê mais o resto do site.
- SharePoint — **anexos próprios do Omni/Foco (escrita)**: site dedicado, separado do comercial (ver Fase 3 e `docs/integracoes/m365-registro.md`); arrastar para a conversa entra com as conversas.
- Teams: reuniões, gravações e transcrições ligadas à conversa; resumo automático.
- **Pronto quando:** a diretoria vê na aba E-mails todos os e-mails da missão piloto, de qualquer caixa autorizada, com o motivo do vínculo.

> **Estado em 03/11/2026:** registro `Omni – Integrações` criado (IDs no `.env`), caixa e política do Teams do piloto feitas. **Leitura das pastas comerciais implementada** (migration 0020; worker `prisma-comercial`; cliente Graph em `@omni/integrations/graph`; aba **Arquivos** da missão com as pastas da missão e as outras do cliente; download por `/api/arquivos/...`), testada com fixtures sintéticas e contra o sandbox do Prisma (vazio). Certificado e concessão `Read` conferidos em 04/11/2026 (o Omni lê a biblioteca do site Arquivos Filtrovali). O `SHAREPOINT_DRIVE_ID` do Prisma é essa biblioteca (confirmado em 04/11/2026). **Não concluída:** validar com pastas reais (a API de produção do Prisma ainda está desligada e o sandbox está vazio); (alcance já restrito). Missão do Prisma ↔ missão do Omni: pelo **vínculo oficial do filtroAPP** (`prisma` em `/projetos`, entregue em 04/11/2026; migration 0021, método `filtroapp`, com prioridade) e, na falta dele, pelo número (único dos dois lados, sem CNPJ em conflito). Validado de ponta a ponta em 04/11/2026 com o sandbox do Prisma: aba Arquivos da missão 5851 abre pastas e subpastas reais e baixa arquivos; item fora da pasta vinculada é recusado. **E-mails da missão em 04/11/2026:** caixas cadastradas na Administração, leitura incremental pelo Graph (Entrada e Enviados), só os e-mails ligados a missões (sem o corpo), motivo do vínculo, aba E-mails para diretoria e gerentes com registro de quem abriu e "Comentar no Interno". Validado com a caixa do piloto: 77 e-mails em 47 conversas ligados pelo número da missão ou por proposta. Depois, no mesmo dia: download de anexos pelo servidor, desvincular vínculo errado (sem religar) e **envio** (novo e resposta no fio, Para/Cc/Cco com sugestões, assinatura por pessoa, só da própria caixa, registro em `mail_outbox`) em **modo de ensaio** fora da produção. Falta: o primeiro envio real (só em produção, `EMAIL_ENVIO=real`), vínculo por domínio com dados reais (domínios das empresas no Prisma de produção), @menção e anexar arquivo no e-mail, anexar e-mail na conversa, tempo real por webhook (só com o Omni publicado).

> **Teams em 05/11/2026:** reuniões da agenda das caixas cadastradas ligadas à missão pelas regras dos e-mails (migration 0026, worker `teams-reunioes`), aba **Reuniões** (diretoria e gerentes) e, pela transcrição, resumo pela IA com decisões e pendências (que viram tarefa da missão) publicado no Gerencial em horário útil; a transcrição não é guardada. Conferido com a agenda real do piloto (6 eventos lidos, nenhum citando missão). **Bloqueio:** o acesso do Graph às transcrições está desligado no tenant (`GraphAccessToTranscriptsDisabled`); ligar por `docs/integracoes/teams-transcricoes.md` e testar com uma reunião real. Gravações ficam de fora (o resumo vem da transcrição).

> A Fase 3 já usa um pedaço do Graph (anexos no SharePoint e e-mail de lembretes). O app Entra com essas permissões sai na Fase 0.

### Fase 5 — IA v1: ciclo da missão sem LLM (M)
- Máquina de estados e agenda (`ai_questions` + pg-boss + calendário útil).
- Fluxos com botões/formulários curtos: criação da missão (vendedor, dados do cliente, responsável pela documentação, previsão de mobilização), mobilização (D-5 úteis, D-1, início em campo), desmobilização, medição (função **Medição**), aprovação, faturamento (função **Faturamento**), aguardando pagamentos (Omie).
- **Descarga do equipamento** confirmada pelo **Líder de Projetos** da missão (`leaderUserId` no filtroAPP, o planejador que acompanha o projeto); a IA lê a NF no Omie e o CT-e no Omie (via filtroAPP) para a previsão de chegada.
- Tarefas criadas pela IA já nascem no módulo Tarefas (Fase 3).
- **Todo "não" vira desvio** no filtroAPP (rota nova) e marca a função Qualidade + Gestor de Contrato no Interno.
- A IA **não pergunta o que o filtroAPP já sabe** (consulta checklists e datas antes).
- **Pronto quando:** a missão piloto passa da criação à mobilização com todas as perguntas no horário útil e os desvios aparecendo no filtroAPP.

### Fase 6 — Prisma (M)
> **03/11/2026:** a leitura com o `reader` da aplicação já roda no worker para empresas, oportunidades e missões (só identidade e pastas do SharePoint, sem valores nem contatos): carga com `highWatermark`, eventos e `updated_since`.
> **11/11/2026 (contrato 1.67.0, Prisma 1.83.0):** bloco "No Prisma" (lookup), participantes do cliente enviados e tirados, ligação e e-mail registrados como feedback em nome da pessoa — testado no sandbox. Falta: ativar a produção da API do Omni no Prisma (pronta e desligada) quando o Omni entrar em produção, e o registro em lote.
- Bloco "No Prisma" no contato, oportunidades para perfis de vendas, registrar feedback/histórico (individual e em lote), sincronização automática.
- Participantes da missão: contatos **do cliente** replicados no Prisma; terceiros ficam só no Omni.
- **Pronto quando:** uma ligação ou e-mail vira feedback no Prisma com um clique.

### Fase 7 — WhatsApp (G)
> **Estado em 05/11/2026:** Evolution própria do Omni pronta para desenvolvimento e produção (`deploy/evolution`, mesma versão e patch do Prisma; perfil `whatsapp` no compose de produção, sem porta exposta), interface `WhatsApp` + cliente da Evolution, webhook autenticado, números/conversas/mensagens com RLS (migration 0027), Administração → WhatsApp com pareamento por QR na tela e worker `whatsapp-estado`. Pareado com o celular de teste: Conversas em tempo real, fotos e arquivos pelo servidor, resposta (ensaio fora da produção), grupo ligado à missão na aba WhatsApp da missão (quem vê o Interno lê), histórico só dos grupos escolhidos (opção A) e recuperação do que o webhook perder (migrations 0028–0029). Depois: sugestão grupo ↔ missão pelo número no nome do grupo (com "Não é") e envio de arquivo (migration 0030). Falta: importar o histórico real e o envio real na produção. Passo a passo: `docs/integracoes/whatsapp-evolution.md`.
> **Revisto em 03/11/2026 (ADR 0004):** pela **Evolution com QR code**, não pela Cloud API. Não depende mais da verificação da Meta; depende de uma **Evolution própria do Omni** (decidido em 04/11/2026, separada da do Prisma) e do inventário dos números. Travas: ensaio por padrão, sem disparo em massa, internas/gerenciais nunca saem.
- **Decidido:** separado no início — números de vendas continuam no Atendimento do Prisma; o Omni começa com números de **operação/missões**. Cada número fica conectado a um sistema só.
- Cloud API com 1–2 números piloto (coexistência app + API quando possível), webhooks, mídia, templates fora da janela de 24 h, grupos de missão (verificar o suporte atual da Cloud API a grupos — **risco**, ver seção 12), linhas por usuário.
- Mensagens internas/gerenciais **bloqueadas no código** de saírem pelo WhatsApp (teste automatizado).
- Chamadas: só o que for viável pela Calling API; aviso de gravação (LGPD).
- **Pronto quando:** os números piloto atendem pelo Omni sem perder mensagens por uma semana.

### Fase 8 — IA v2 com LLM (M)
> **Estado em 05/11/2026:** leitura diária dos RDOs pronta (GPT `gpt-6-luna`, avaliação 10/10, 10 RDOs reais lidos por ≈ US$ 0,002). Regras do regime por código, texto pelo LLM com citações conferidas, pergunta no Interno pelo mesmo caminho da IA v1, metadados em `llm_calls`. Falta: `@IA`/`/alerta`, detecção de "chegamos", participantes e cargos, resumo de chamadas, aprendizado com as respostas "não" e avaliação no CI.
- Alertas por comando `@IA` / `/alerta` com saída estruturada, confirmação antes de ativar e aprendizado ("veio mas você não encontrou"). **Feito em 05/11/2026** (migrations 0031–0032): conferido com um pedido real na missão 5800 (entendido certo, disparo com os RDOs 93 e 94, exemplo aprendido).
- Leitura diária dos RDOs às 7h (sem avanço de escopo, fora do regime → fluxo de formalização).
- Detecção de chegada no grupo ("chegamos"), detecção de participantes e cargos, resumo de chamadas e tarefas sugeridas.
- Avaliação: conjunto de casos reais anonimizados com resultado esperado, rodado no CI quando o prompt mudar.

### Fase 9 — Gestão e revisão semanal (M)

> Estado em 03/11/2026: Revisão semanal no ar para gerente e diretoria, com os dados da Gestão do filtroAPP (B6): avanço e meta por semana, custos × avanço, equipamentos em obra × permanência prevista e diária, alocações e horas do ponto. Aba Gestão por missão no ar (avanço semana a semana, custo × avanço e composição do gasto, equipe prevista × ponto, horas, equipamento em obra). Meta como cadastrada no filtroAPP (m, L, un, colaboradores por dia, por serviço) ligada em 03/11/2026 na Revisão e na aba. Falta a composição do avanço por serviço.
- Depende de liberar os escopos de custos, Omie, ponto, romaneio e alocações no filtroAPP.
- Aba Gestão (custos × avanço, evolução, composição do avanço, HH, dias trabalhados, equipamentos em obra com permanência prevista e diária de stand-by, romaneios, faturamento, desvios) e tela de Revisão semanal com os 6 indicadores, espelhando a revisão de execução do filtroAPP.

### Fase 10 — Unificação do WhatsApp (M)
- Migrar os números de vendas do Prisma para o Omni, pela Evolution (ADR 0004).
- O Prisma passa a ler conversas e registrar feedbacks a partir do Omni; desligar o Atendimento do Prisma número a número.
- **Pronto quando:** todo cliente tem uma conversa única no Omni, juntando vendas e operação.

### Fase 11 — Endurecimento e app (M)
- Alertas de risco (download em massa, envio de arquivo para fora), retenção por tipo de dado, revisão de RLS por terceiro, teste de carga, plano de incidentes.
- PWA instalável com push; avaliar app nativo. **Feito em 05/11/2026:** manifesto, service worker só de notificações, Web Push pelo worker (avisos, canais acompanhados, WhatsApp), preferências por pessoa; conferido no Chromium (instalável, inscrição e notificação de teste entregue). Falta conferir em Android e iPhone com o Omni publicado (HTTPS).

> **Piloto contínuo:** a partir da Fase 2, escolher **uma missão real** e um grupo pequeno (Otávio + um líder de projetos + um gerente) para usar em homologação a cada entrega.

---

## 9. Trabalho necessário nos outros sistemas

Confirmado pelo Otávio em 26/10/2026: essas mudanças podem andar em paralelo, no backlog de cada sistema.

### filtroAPP (prioridade alta — destrava Fases 2, 5 e 9)
1. **Eventos de saída**: feed `GET /integracoes/v1/events` com cursor (ou webhooks assinados) a partir da `NotificationEvent` — RDO criado/aprovado/assinado/devolvido, mudança de etapa, registro de Qualidade, romaneio emitido.
2. Expor RDOs também em `PENDING`, `RETURNED` e `SIGNED` (hoje só `APPROVED`), com escopo próprio.
3. Projeção `/projetos` com regime (`includesSaturday/Sunday`, `workdayHours`), responsáveis (`leaderUserId`, `plannerUserId`, `operatorId`), datas comerciais e de mobilização, **permanência prevista em obra** (`CommercialProposal.plannedDays`) e **diária de stand-by de equipamentos** (`components.diariaEquipamento`).
4. Liberar escopos de leitura: `acompanhamento.progresso/custos`, `omie.*`, `ponto.*` (agregado por projeto), `romaneios.*`, `efetivo.alocacoes/feriados`, `usuarios.diretorio`.
5. Escritas: **criar registro de Qualidade** (origem "Omni", responsável por usuário) e **confirmar descarga** do equipamento (pelo Líder de Projetos: data, parcial × total), data de viagem.
6. Campos novos: vendedor (FK), responsável pela documentação, coordenador de mobilização; chegada/descarga e parcial × total de equipamento; feriados municipais com cidade.
7. Sincronização do Omie: incluir **CT-e** (hoje só NFS-e, NF-e e ND) e ligá-lo ao romaneio/projeto.
8. Corrigir o README (RTP = Teste de Pressão, RCPU = Contagem de Partículas e Umidade, RLF = Flushing, RLI = Inibição).

### Prisma CRM (prioridade média — Fases 3 e 6)
1. Feedback/histórico com **vários vínculos** (oportunidade + contato pessoa + contato CNPJ) numa chamada.
2. Upsert de contato por telefone/e-mail; `taxId` e código público da oportunidade nas respostas.
3. Vincular participante externo à missão.
4. Eventos ("oportunidade ganha", contato alterado) para o Omni, ou polling por `updated_since` como solução inicial.
5. **Tarefas:** reapontar a integração do Foco (leitura de tarefas + autorização PKCE) para o Omni no dia do corte da Fase 3.
6. **Atendimento/WhatsApp**: manter os números de vendas no Prisma até a Fase 10; depois ler conversas e feedbacks do Omni e desligar o Atendimento.

### Foco (até ser desligado na Fase 3)
1. ✅ Repositório disponível (`../foco/foco`).
2. Congelar funcionalidades novas a partir do início da Fase 3 (só correções), para a paridade não andar enquanto migra.
3. Acesso de leitura ao banco e ao Storage para a migração.
4. Modo **somente leitura** acionável no dia do corte.
5. ⚠️ A cópia local tem `.env` com chaves do Supabase — confirmar que as chaves foram giradas (pendência do INSTRUCOES).

### Sistema de documentação dos colaboradores (app próprio, em construção)
1. API de leitura por colaborador: documentos, exames, treinamentos, validade, liberação por cliente, integração feita/agendada.
2. Até lá, o Omni usa só os checklists do filtroAPP (`TeamMemberCheck`) por trás de uma interface "provedor de conformidade".

---

## 10. Segurança e LGPD

- **Login só Microsoft**, MFA por Acesso Condicional, atribuição obrigatória no app Entra, sessão curta com renovação; desligou no Entra → sessão revogada na próxima verificação.
- **RLS em todas as tabelas com dado de usuário**, testado no CI com perfis reais (diretoria, gerente, líder, vendedor, operação, pessoa fora da missão, pessoa com `history_since`).
- **Graph com menor privilégio:** permissões de aplicação limitadas por *Application Access Policy* às caixas autorizadas; todo e-mail aberto por quem não é dono da caixa vai para a auditoria.
- **Política escrita e comunicada** de que e-mails de missões ficam visíveis à gestão (exigência do INSTRUCOES) — validar com o encarregado (`privacidade@filtrovali.com.br`).
- **ROPA**: incluir o Omni e os operadores novos (Meta, Microsoft, OpenAI, STT) e firmar DPAs — roteiro em `docs/producao/lgpd-ropa-dpa.md`.
- **LLM**: enviar só o necessário; sem retenção para treino; registrar metadados (não o texto) por padrão; o usuário vê quando a IA usou um conteúdo.
- **Gravação de chamadas**: aviso ao participante, retenção configurável, acesso restrito.
- **Retenção**: alinhar com a tabela do filtroAPP (logs de API 365 dias, IP/UA anonimizados após 2 anos) e definir prazos para mensagens e gravações.
- **Segredos** em variáveis de ambiente validadas no boot (Zod), nunca no repositório; certificado do Entra fora da imagem.
- **Logs** com `requestId`, sem `Authorization`, corpo de mensagem ou tokens.

---

## 11. Qualidade de engenharia

- **Testes de regra pura** (Vitest) para calendário útil, vínculo e-mail↔missão, parsing de comandos, máquina de estados da IA.
- **Testes de RLS** contra Postgres real no CI.
- **Testes de contrato** dos adaptadores (filtroAPP via OpenAPI; Prisma, Foco, Graph e Meta com respostas gravadas).
- **e2e Playwright** reaproveitando os cenários de `testes/` do protótipo como roteiro (mobilização, encerramento, e-mail Outlook…).
- **Homologação** com envio externo desligado por padrão (mesma ideia do `SEND_CLIENT_EMAILS=false` do filtroAPP), números de WhatsApp de teste e caixas de teste.
- **Feature flags** por módulo e por missão para liberar aos poucos.
- O protótipo continua como **especificação visual**: cada tela nova é comparada com ele.

---

## 12. Riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Sobreposição Omni × Atendimento do Prisma gera dois inboxes de WhatsApp | Certa (temporária) | Médio | Decidido: separado por número no início, unificação planejada na Fase 10. |
| Banimento de número pela Evolution (QR code não é oficial — ADR 0004) | Média | Alto | Risco aceito em 03/11/2026. Sem disparo em massa, envio sempre por uma pessoa, limite por número; contingência: migrar o número banido para a Cloud API pela mesma interface. |
| Sessão da Evolution cai (aparelho desconectado, mudança do WhatsApp) | Média | Médio | Monitorar a sessão de cada número e avisar no Omni; reconciliar mensagens ao reconectar. |
| Dependência de mudanças no filtroAPP/Prisma/Foco | Alta | Alto | Backlog da seção 9 entra no mesmo cronograma; polling como solução inicial. |
| Migração do Foco perder dados ou quebrar o uso diário | Média | Alto | Script idempotente com `foco_id`, validação por contagem e hash, ensaio em homologação, Foco somente leitura por 30 dias, API `/api/v1` compatível. |
| Paridade do Foco andar durante a migração (Lovable continua aceitando mudanças) | Média | Médio | Congelar funcionalidades novas no Foco no início da Fase 3. |
| Consentimento de administrador do Graph e política de leitura de e-mails | Média | Alto | Política escrita + escopo mínimo + auditoria. |
| Custo e latência do LLM | Média | Médio | Fluxos por botão sem LLM; modelo menor para volume; cache; limites por missão. |
| Adoção (o time continuar no WhatsApp Web) | Média | Alto | Interno/Gerencial **só** existem no Omni; piloto com líderes; mobile bom desde a Fase 1. |
| Dados sensíveis num lugar só | — | Muito alto | RLS, MFA, auditoria, backups cifrados, revisão de segurança antes de abrir para todos. |

---

## 13. Perguntas para o Otávio

**Decididas em 26/10/2026:**
1. ✅ **Stack:** Opção B — Postgres próprio com RLS, mesmo padrão operacional do filtroAPP/comercialAPP, front TanStack Start do Foco (seção 5.3).
3. ✅ **Quem vê as conversas de clientes:** combinação — atendentes da linha de WhatsApp + vendedor dono da empresa no Prisma (e seu supervisor) + membros da missão quando o contato for da missão + diretoria vê tudo. Vira política RLS na Fase 1.

2. ✅ **WhatsApp:** separado no início (vendas no Prisma, operação no Omni, cada número em um sistema só), unificado no Omni depois (Fase 10).
4. ✅ **Responsáveis da Qualidade e da documentação:** sem nomes no código; funções configuráveis (seção 4.1).
6. ✅ **Multa de equipamento:** permanência prevista em obra + diária de stand-by de equipamentos, da proposta (seção 2, item 10b).
8. ✅ **Documentação dos colaboradores:** hoje Solides, migrando para **um app próprio separado**. O Omni lê por uma interface de "provedor de conformidade" e integra quando a API do app novo existir.
9. ✅ **Foco:** cópia em `../foco/foco`; Supabase na nuvem via Lovable. **Será absorvido pelo Omni** (Fase 3): migra primeiro, desliga depois.
5. ✅ **NF e CT-e** ficam no Omie; a **descarga** é confirmada pelo Líder de Projetos da missão (planejador e líder de projetos são a mesma função).
10. ✅ As mudanças no filtroAPP, no Prisma e no Foco (seção 9) podem andar em paralelo.
7. ✅ **Terceiros** (hotel, transportadora, fornecedores) ficam só no Omni; contatos do cliente vão para o Prisma.
12. ✅ **Anexos das tarefas do Foco** vão para uma biblioteca do SharePoint dedicada ao Omni.

**Ainda em aberto:**
11. Assinaturas de e-mail dos colaboradores e selos ISO 9001/GPTW (baixa prioridade).
13. ✅ **Quem vê a lista de Missões** (decidido em 10/11/2026, migration 0045): Diretoria, Administração e Gerentes veem todas; os demais (inclusive Operação), só as associadas — responsáveis e equipe alocada no filtroAPP, membros do Interno ou do Gerencial, função chamada pela IA — e as que a Diretoria ou a Administração liberarem na missão. Vale para a missão, RDOs, relatórios, dados do filtroAPP e pastas da missão. *Antes:* provisório (decidido em 28/10/2026): qualquer pessoa com algum perfil no Omni vê a lista (política `missions_select` na migration 0002). Resolver depois: restringir por papel e/ou por membro da missão. Os canais Interno e Gerencial já terão regras próprias por membro.
