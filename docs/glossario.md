# Glossário

Termos do negócio, do produto e do código do Omni. No código, o nome em português é o do negócio;
quando a tabela ou a coluna está em inglês, ela vem entre parênteses.

## Negócio (Filtrovali)

| Termo | O que é |
|---|---|
| **Missão** (`missions`) | Um serviço contratado e executado em campo (filtragem, flushing, limpeza de tanques…), identificado pelo número do Prisma. A verdade da missão (etapas, equipe, RDOs, custos) é do filtroAPP; o Omni guarda uma cópia para ler e conversar. |
| **Etapa da missão** | As 11 etapas do workflow do filtroAPP, de "Handover comercial" a "Encerrado" (`packages/core/src/mission-stages.ts`). O Omni só mostra; quem muda é o filtroAPP. |
| **Mobilização / desmobilização** | Ida da equipe e dos equipamentos para o cliente e a volta à sede. A IA pergunta em D-5, D-1 e na véspera da saída. |
| **RDO** | Relatório Diário de Obra: o que a equipe fez no dia, horas e ocorrências. Emitido e assinado no filtroAPP; o Omni lê, mostra e a IA confere. |
| **Desvio / Qualidade** | Não conformidade registrada no módulo Qualidade do filtroAPP. A IA do Omni pode abrir um, conforme `FILTROAPP_ESCRITA`. |
| **Medição** | Levantamento do que foi executado, para faturar. |
| **NF / Omie** | Nota fiscal e o ERP financeiro. O Omni só lê pendências pelo filtroAPP (Entrega B). |
| **Romaneio / descarga** | Documento de transporte dos equipamentos e a confirmação de que chegaram. |
| **Efetivo / alocação** | Quem da equipe está alocado em cada missão, com o ponto (horas). |
| **Meta da semana** | Meta física por serviço (m, L, un…) cadastrada no filtroAPP. O Omni nunca converte para %. |
| **Regime** | Jornada combinada com o cliente (horário, dias). A leitura dos RDOs confere horas fora dele. |
| **Diária de stand-by** | Valor cobrado por dia de equipamento parado à disposição do cliente. |
| **Oportunidade / proposta** | Negociação no Prisma CRM antes de virar missão. |

## Produto (telas e funções do Omni)

| Termo | O que é |
|---|---|
| **Interno** | Canal da missão só para o time da Filtrovali. Nunca vai para o WhatsApp. |
| **Gerencial** | Canal da missão para gerentes e diretoria (resumos das reuniões, decisões). |
| **Caixa única** | Lista que junta WhatsApp, e-mails, missões e tarefas por contato, com os filtros Tudo, WhatsApp, E-mail, Missões e Tarefas. |
| **Contato / identidade** (`contacts`, `contact_identities`) | Agenda da empresa: cada telefone ou e-mail pertence a um contato só. |
| **Pergunta da IA** | Mensagem da IA no Interno com opções de resposta que fazem o ciclo da missão andar. Fluxos em `packages/core/src/ia/fluxos.ts`. |
| **Janela útil** | Seg–sex, 08–18 h, fora de feriados. A IA só publica nela (`BusinessCalendar`). |
| **Alerta pedido à IA** | `@IA` ou `/alerta` no canal: uma regra que a IA vigia nos RDOs e só vale depois de **Ativar**. |
| **Alerta de risco** | Download em massa ou arquivos para fora, somados por pessoa (Administração → Segurança). |
| **Erro do sistema** | Erro inesperado do web, do worker ou do backup, agrupado e avisado a quem é admin (Administração → Erros). |
| **Incidente** | Algo que afetou pessoas, dados ou a segurança. Registrado com causa e correção (Administração → Incidentes). |
| **Perfil** (`person_profiles`) | Papel de acesso: `admin`, `diretoria`, `gerente`, `lider_projetos`, `vendas`, `marketing`, `supervisor`, `operacao`. Dá permissão. |
| **Função** (`functions`, `function_assignments`) | Cargo da empresa (líder de projetos, financeiro…). A IA endereça funções, nunca nomes. |
| **Módulo** | WhatsApp, E-mail, Missões, Tarefas, Chamadas, Revisão: liberados por perfil ou pessoa (Administração → Módulos). |
| **Login interno** | Usuário e senha para quem não tem conta Microsoft; e-mail `@interno.omni.invalid`. |
| **Revisão semanal** | Tela de gestão com uma linha por missão ativa (avanço, RDOs, custos, alertas). |
| **Inbox zero / concluir** | Tirar a conversa da lista até chegar mensagem nova. |
| **Termo de uso** | Aceite obrigatório no primeiro acesso (LGPD). Mudou o texto, muda `TERMOS.versao`. |

## Sistemas ao redor

| Termo | O que é |
|---|---|
| **filtroAPP** | Sistema operacional da Filtrovali (missões, RDOs, qualidade, efetivo, custos). O Omni lê pela API de integrações e escreve só pelos modos de escrita. |
| **Prisma (Prisma CRM)** | CRM: empresas, contatos, oportunidades, número da missão e pastas comerciais do SharePoint. |
| **Foco** | App de tarefas que o Omni absorveu (módulo Tarefas, API `/api/v1` compatível). |
| **Entra (Entra ID)** | Diretório da Microsoft: login, MFA e quem pode entrar (atribuição ao app "Omni"). |
| **Graph** | API da Microsoft para e-mails, agenda, Teams e SharePoint (app "Omni – Integrações"). |
| **OmniAnexos** | Site do SharePoint onde ficam arquivos dos canais, anexos das tarefas e gravações cifradas. |
| **Evolution** | Servidor que conecta números de WhatsApp por QR code (ADR 0004). |
| **`@lid`** | Identificador do WhatsApp que esconde o número. O Omni liga ao número pelo mapeamento da sessão. |
| **Serviço de voz** | Programa à parte (`experiments/whatsapp-chamada`) que faz as chamadas do WhatsApp; fala com a Evolution pela **ponte**. |
| **Grafana Cloud / Alloy** | Onde ficam os logs (Loki) e o agente que os envia já mascarados (`deploy/logs`). |
| **B2** | Backblaze B2, onde fica a cópia remota do backup. |
| **ANPD / encarregado** | Autoridade de proteção de dados e a pessoa responsável pela LGPD na empresa (`privacidade@`). |

## Código e operação

| Termo | O que é |
|---|---|
| **Web / worker** | Os dois processos: `apps/web` (telas, server functions, rotas) e `apps/worker` (jobs agendados). |
| **Server function** | Função do servidor chamada pela tela (TanStack Start, `createServerFn`). Só devolve `ErroParaTela` ao navegador. |
| **Job** | Tarefa do worker no pg-boss (`filtroapp-missoes`, `outlook-emails`, `retencao`, `saude`…). |
| **pg-boss** | Fila de jobs no próprio Postgres (esquema `pgboss`). |
| **RLS** | Row Level Security: o Postgres decide quem vê cada linha. Toda tabela nova tem RLS e teste. |
| **`omni_app` / `omni_worker` / `omni_owner`** | Papéis do banco: web, worker (os dois sem BYPASSRLS) e dono das tabelas (só migrations). |
| **`withPerson`** | Abre uma transação com a pessoa da sessão, para o RLS saber quem está pedindo. |
| **`app.*`** | Esquema das funções do banco (`app.ve_missao`, `app.has_profile`…). Toda função nova precisa de `GRANT EXECUTE` explícito. |
| **Migration** | Arquivo `packages/db/migrations/NNNN_nome.sql`. Aplicada não se edita (o executor confere o SHA-256). |
| **Ensaio / simulada / real** | Modos das integrações que escrevem para fora: ensaio só registra, simulada valida sem gravar, real grava (só na produção). |
| **Staging** | Cópia da produção com dados próprios e as travas de fora da produção (`omnistaging.filtrovali.com.br`). |
| **`publicar.sh`** | Script de deploy: build com a versão, migrations, subida e conferência de `/api/saude`. |
| **Ensaio de restauração** | Restauração automática do backup num banco descartável, para provar que ele volta. |
| **CSP** | Content-Security-Policy: quais scripts e origens a página aceita (`CSP_MODO`). |
| **E2E** | Bateria ponta a ponta (Playwright, `e2e/omni.e2e.ts`) que roda no CI sobre o build de produção. |
| **Pilares / Entregas (E01…E23)** | Régua de maturidade do projeto e o plano que a cumpre (`docs/entregas.md`). |
