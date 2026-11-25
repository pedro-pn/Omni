# Central Filtrovali — documento de continuação

> Leia este arquivo inteiro antes de mexer em qualquer coisa. Ele explica a ideia do produto, tudo o que foi construído no protótipo, as regras de negócio combinadas com o Otávio, as integrações necessárias, as decisões que ainda estão em aberto e os próximos passos.
>
> Versão do protótipo: **v24** (26/10/2026). Autor do pedido: **Otávio Barcelos, Diretor Executivo da Filtrovali** (otavio.barcelos@filtrovali.com.br).

---

## Sumário

1. [A ideia em uma página](#1-a-ideia-em-uma-página)
2. [A Filtrovali e o vocabulário da casa](#2-a-filtrovali-e-o-vocabulário-da-casa)
3. [O que existe hoje](#3-o-que-existe-hoje)
4. [Conteúdo deste pacote e como rodar](#4-conteúdo-deste-pacote-e-como-rodar)
5. [Mapa da interface](#5-mapa-da-interface)
6. [Funcionalidades em detalhe](#6-funcionalidades-em-detalhe)
7. [A IA da Central: todos os fluxos](#7-a-ia-da-central-todos-os-fluxos)
8. [Permissões e perfis](#8-permissões-e-perfis)
9. [Regras de negócio consolidadas](#9-regras-de-negócio-consolidadas)
10. [Integrações necessárias](#10-integrações-necessárias)
11. [Arquitetura recomendada para a versão real](#11-arquitetura-recomendada-para-a-versão-real)
12. [Modelo de dados proposto](#12-modelo-de-dados-proposto)
13. [Segurança e LGPD](#13-segurança-e-lgpd)
14. [Como o código do protótipo está organizado](#14-como-o-código-do-protótipo-está-organizado)
15. [Dados fictícios (trocar pelos reais)](#15-dados-fictícios-trocar-pelos-reais)
16. [Decisões em aberto](#16-decisões-em-aberto)
17. [Próximos passos](#17-próximos-passos)
18. [Links](#18-links)

---

## 1. A ideia em uma página

Hoje cada colaborador da Filtrovali trabalha com 4 a 5 telas abertas: **WhatsApp Web** (vários números de WhatsApp Business), **Outlook** (e-mail corporativo), **SharePoint** (pastas das oportunidades e missões), **Prisma CRM** (oportunidades, feito pelo Otávio com IA) e **Foco** (tarefas tipo Todoist, também feito pelo Otávio com IA). A informação se perde entre elas.

A **Central Filtrovali** é **uma tela única, com cara de WhatsApp**, onde:

- Cada **cliente** é uma conversa que junta WhatsApp, e-mail, ligações e videochamadas gravadas e transcritas, arquivos do SharePoint, oportunidade do Prisma e tarefas do Foco.
- Cada **Missão** (projeto ganho) é um grupo com camadas: **grupo do WhatsApp** (campo e cliente), **canal Interno** (só no sistema, equipe interna), **canal Gerencial** (só quem a diretoria escolher), **E-mails da missão**, **RDOs**, **Relatórios técnicos** e **Gestão** (indicadores para gerentes).
- Uma **IA interna** acompanha cada missão do início ao fim: pergunta o que falta, cobra datas, lê os RDOs, abre desvios, marca as pessoas certas, sempre em horário útil.
- A conversa some da tela quando é **concluída** e volta sozinha quando chega novidade (inbox zero).
- Deve funcionar no **computador e no celular** (primeiro web/PWA, depois app).
- **Segurança muito alta**: são todos os dados da empresa.

Objetivo de negócio declarado pelo Otávio: centralizar, fazer o time interno **usar o sistema** (as comunicações internas só aparecem nele) e dar à diretoria visão completa de cada missão sem pedir para ninguém.

---

## 2. A Filtrovali e o vocabulário da casa

- Empresa de **filtragem de óleo de máquinas** (flushing, filtragem, diálise de óleo hidráulico/lubrificante/turbina, limpeza química, hidrojateamento, locação). Sede em **Itajaí - SC**. Fundada em 2005.
- **Oportunidade**: no Prisma, código numérico de proposta (ex.: 4100, 4200). No protótipo usei `OP-AAAA-NNNN` para ficar legível; **ajustar para o padrão real do Prisma** (cards com número da proposta e cliente, temperatura Fria/Morna/Quente, colunas por prazo de fechamento).
- **Missão**: projeto ganho, número de 4 dígitos. Grupo de WhatsApp no padrão **`Missão 5712 - Cliente (detalhe)`**. Um cliente pode ter várias missões.
- **RDO**: Relatório Diário de Obra, feito pelo **líder de campo**; precisa ser assinado pelo cliente.
- **Relatórios técnicos** (confirmado pelo Otávio em 26/10/2026): **RTP** Teste de Pressão · **RLQ** Limpeza Química · **RCPU** Contagem de Partículas e Umidade · **RLM** Limpeza Mecânica · **RLF** Flushing · **RLI** Inibição. Vêm do filtroAPP.
- **Romaneio**: equipamento separado e disponível para ir à obra (não significa que chegou).
- Papéis em uma missão:
  - **Líder de projetos** (fica na sede, faz a interface entre cliente, campo e áreas internas: qualidade, documentação, financeiro, RH, engenharia, operações, comercial).
  - **Gerente do contrato**.
  - **Líder de campo** (responsável pela equipe na obra; usa só WhatsApp; faz o RDO).
  - **Vendedor da carteira** (normalmente quem cria o grupo: Davi, Josué, Ana Clara, Caetano, Ronaldo). Às vezes quem cria é supervisor/gerente (Wanderson, Gilmar, Jaqueline).
  - **Responsável pela documentação** da missão.
  - **Quem conduz a mobilização** (equipe e equipamentos): **Rosana** ou **Valéria**.
  - **Sérgio**: mede o término dos serviços.
  - **Priscila**: faturamento (emite NF, fecha no Omie).
  - **Gilmar**: gerente comercial.
  - **Qualidade**: recebe todos os desvios (no protótipo é a Débora — confirmar nome real).
- Identidade visual: veja `identidade-visual/` (verde Floresta `#30503A`, Nuvens `#E8E8E8`, secundárias azul `#11437E`, vermelho `#C81519`, lilás `#9B93A8`, fonte **Poppins**). Brand book do Estúdio Molina (2024).

---

## 3. O que existe hoje

- **Um protótipo navegável em um único arquivo HTML** (`prototipo/index.html`, ~3.000 linhas, HTML + CSS + JS puro, sem build). Todos os dados são **fictícios** e ficam em memória (nada é salvo).
- Publicado como artifact privado no claude.ai (link no fim).
- **Design System "Filtrovali"** publicado (tokens, README da marca, logos) e uma **skill** `identidade-visual-filtrovali` proposta.
- **Nenhuma integração real foi feita.** Tudo que "envia" ou "lê" é simulado.
- O repositório do **Foco** foi analisado (TanStack Start + React 19 + Supabase + Tailwind 4 + login Microsoft + PWA + API pública `/api/v1` + integração PKCE com o Prisma). **Ele não está neste zip** (o zip original tinha um `.env` com chaves do Supabase — não redistribuir; ver Segurança).

---

## 4. Conteúdo deste pacote e como rodar

```
central-filtrovali/
├── INSTRUCOES.md                 ← este documento
├── CLAUDE.md                     ← instruções curtas para o Claude Code
├── package.json                  ← scripts para abrir e testar
├── prototipo/
│   ├── index.html                ← protótipo completo, abre direto no navegador
│   └── central-filtrovali.fragment.html  ← mesmo conteúdo sem <html>/<body> (formato do artifact)
├── identidade-visual/
│   ├── design-system/            ← tokens.json, README.md da marca, capa
│   ├── logos/                    ← logo horizontal e símbolo (color/white), ícone exemplo do Foco
│   └── skill/SKILL.md            ← skill "identidade-visual-filtrovali"
└── testes/                       ← testes de fumaça com Playwright (test.js … test27.js, run-all.js)
```

**Abrir o protótipo:** dê dois cliques em `prototipo/index.html`, ou `npm run abrir` e acesse http://localhost:4321. Precisa de internet só para a fonte Poppins (Google Fonts); sem ela cai na fonte do sistema.

**Rodar os testes:**

```bash
npm install
npx playwright install chromium
npm run testar      # screenshots ficam em testes/screenshots/
```

Cada `testN.js` cobre uma rodada de funcionalidades (ex.: `test14.js` = ciclo de mobilização da IA, `test20.js` = encerramento/medição, `test26.js` = e-mail Outlook). Eles imprimem `[]` quando não há erro de JavaScript na página.

**Dica para testar o protótipo à mão:** o avatar no canto inferior esquerdo troca o **perfil de teste** entre Otávio (diretoria), Marina (líder de projetos, operação) e Davi (vendedor). A Missão 5850 é a mais completa; 5861 está em mobilização; 5872 acabou de ser criada; 5712 está encerrada.

---

## 5. Mapa da interface

```
┌──────┬──────────────────┬─────────────────────────────────────┬──────────────────────┐
│Trilho│ Lista            │ Conversa                            │ Painel do contexto   │
│      │ (Conversas,      │  cabeçalho + abas da missão         │ (Cliente / Missão /  │
│ Conv.│  Oportunidades*, │  linha do tempo                     │  Colaborador)        │
│ Opps*│  Tarefas,        │  campo de escrita com canais        │  abas Resumo,        │
│ Taref│  Revisão semanal,│  (WhatsApp/E-mail/Nota ou           │  Arquivos, Tarefas,  │
│ Rev. │  Chamadas)       │   WhatsApp/Interno/Gerencial)       │  Jornada             │
│ Cham.│                  │                                     │                      │
│ Sino │                  │                                     │                      │
│ Tema │                  │                                     │                      │
│ Seg. │                  │                                     │                      │
│ Perfil                  │                                     │                      │
└──────┴──────────────────┴─────────────────────────────────────┴──────────────────────┘
* Oportunidades só para diretoria, vendas, marketing e supervisores.
```

Celular (≤760px): uma tela por vez (lista → conversa → painel), trilho vira barra inferior, campos com fonte 16px (evita zoom do iOS), layout acompanha o teclado (`visualViewport`).

---

## 6. Funcionalidades em detalhe

Entre parênteses: funções/constantes principais no código.

### 6.1 Lista de conversas (`renderList`, `visibleConvs`)
- Filtros: **Todas, Não lidas, Pessoas, Missões, WhatsApp, E-mail** e seletor de **linha de WhatsApp** (são 20+ números).
- Missões aparecem **agrupadas por cliente** e mostram a etapa atual ("Etapa 9/13 · Execução e medições") ou a fase de encerramento.
- Badges: não lidas (verde), mensagens internas (lilás com cadeado), gerenciais (azul com escudo).
- **Concluir** (botão no topo ou **deslizar para a esquerda**, `endSwipe`): a conversa sai de "Todas"; missões continuam em "Missões". **Desfazer** no aviso. **Busca** acha tudo, inclusive concluídas; "Ver concluídas".
- **Volta sozinha** para "Todas" quando chega novidade de outra pessoa ou da IA (`isNewFromOthers` dentro de `push`). O que você mesmo escreve não reabre.
- Depois de responder, aparece a faixa "Respondido. Quer tirar X da sua lista?".

### 6.2 Conversa com cliente (`renderChat`, `itemHTML`, `composerHTML`, `send`)
- Linha do tempo única: WhatsApp, e-mails (cartões), ligações WhatsApp e reuniões Teams gravadas com **resumo automático, transcrição e tarefas sugeridas**, eventos do Prisma/Foco, notas internas.
- Canais de resposta: **WhatsApp** (mostra a linha usada), **E-mail**, **Nota interna**. Responde no canal da última mensagem recebida.
- Comandos com `/`: `/tarefa`, `/lote`, `/alerta`, `/proposta` (anexa a última proposta), `/modelo`, `/nota`.
- Anexos: do computador ou **arrastando arquivos do SharePoint** do painel lateral.
- **Chamadas** (`startCall`/`endCall`): tela de chamada com aviso de gravação (LGPD) e transcrição ao vivo; ao encerrar, gera gravação + transcrição + resumo + tarefas sugeridas.
- Simulações: e-mail novo do Pedro chega ~20s após abrir; resposta do Pedro após enviar o PDF.

### 6.3 E-mail estilo Outlook (`mailFieldsHTML`, `bindMail`, `contactsDB`, `sigHTML`)
- **Para / Cc / Cco** com etiquetas e autocompletar da base de contatos do sistema (equipe, clientes, contatos das empresas, contatos dos vendedores). Enter/vírgula adiciona; Backspace remove. Internos em verde.
- **@menção no texto** marca a pessoa e a adiciona em Para (igual ao Outlook).
- **Anexar outro e-mail** (busca em todos os e-mails do sistema, entra como `.eml`).
- **Assinatura** de quem envia (a do Otávio foi reproduzida do print; as demais usam o mesmo modelo com iniciais). Enter pula linha; **Ctrl/Cmd+Enter** envia.
- Responder já preenche o remetente. Cco aparece só para quem enviou.

### 6.4 Painel do cliente (`resumoHTML`, `prismaBlockHTML`)
- Contato (telefone, e-mail, linha que atende), **No Prisma** (oportunidade, contato pessoa, contato CNPJ), detalhes de oportunidade/propostas/contratos/histórico **só para perfis de vendas**, outros contatos da empresa.
- **Arquivos** (`filesPanelHTML`): pasta do cliente no SharePoint, navegável, arrastável para a conversa.
- **Tarefas**: tarefas do Foco ligadas ao cliente + criação rápida com a sintaxe do Foco.
- **Jornada**: linha do tempo do cliente desde o primeiro contato.

### 6.5 Prisma CRM (`prismaLinks`, `pzModal`)
- Para o time operacional o Prisma importa só no contato. Oportunidades/funil ficam para vendas e marketing.
- **Registrar no Prisma**: qualquer WhatsApp, e-mail, ligação ou reunião vira **Feedback do cliente / Histórico de atividade / Ocorrência**, vinculado a **Oportunidade, Contato pessoa e Contato CNPJ**. Também em lote ("Registrar conversa no Prisma") e **sincronização automática** de ligações/reuniões/e-mails por contato. Itens registrados ganham a etiqueta "Prisma · …".

### 6.6 Tarefas — Foco (`parseTask`, `parseBatch`, `createTask`)
- `/tarefa Revisar memorial +Priscila sexta às 10h p1 #OP-2026-0187` com prévia antes de criar. Mesma sintaxe do Foco: `+pessoa`, `#projeto`/`#Missão`, datas em português, `às 15h`, `p1–p4`.
- **Tarefas em lote** (`/lote`, botão na tela Tarefas e no painel) com 4 formatos (iguais ao Foco):
  1. **Por pessoa**: `NOME - prazo` + tópicos (primeira linha pode ser a Missão).
  2. **Tabela de missões**: `5861 | Cliente | Responsável | Tarefa - prazo`.
  3. **Com rótulos**: `👤 Pessoa | 📅 data` ou `Responsável:`/`Prazo:`.
  4. **Uma por linha** com a sintaxe rápida.
  Revisão editável (projeto, responsável, data, hora), troca de responsável propaga ao grupo do cabeçalho, linhas inválidas em vermelho, limite de 200.
- **Delegar em lote** tarefas existentes (selecionar → responsável → aplicar).
- **Avisos no grupo do WhatsApp da Missão**: tarefa concluída/reaberta (ligado por padrão) e novas tarefas (desligado), configurável por missão, com alerta quando há pessoas do cliente no grupo.
- ⚠️ No real: usar o parser do próprio Foco (`src/features/foco/batch-task-parser.ts` e `smart-parse.ts`) e a API dele, não reimplementar.

### 6.7 Missão — estrutura (`MSTAGES`, `rolesHTML`, `stagesHTML`, `crewHTML`, `agendaHTML`)
- **Abas**: Tudo · Grupo WhatsApp · Interno · Gerencial · RDOs · Relatórios · Gestão · E-mails.
- **Responsáveis**: líder de projetos, gerente do contrato, líder de campo (com telefone), vendedor da carteira (+ quem criou o grupo), responsável pela documentação, dados enviados pelo vendedor (proposta técnica, data de atendimento, contato do cliente com nome/e-mail/telefone, resumo). Botão "Apresentar responsáveis no grupo do WhatsApp".
- **Etapas (13)**: Contrato ganho → Pedido de compra recebido → Líder de projetos definido → Documentação da empresa liberada → Documentação dos colaboradores → Hotel e logística reservados → Equipamentos mobilizados → Equipe em campo → Execução e medições → Desmobilização → Relatório entregue → Medição final aprovada → Faturado. Avançar notifica só a equipe interna. **Lista proposta por mim — confirmar com o processo real.**
- **Equipe, acesso e integração**: em campo (dias em campo, alerta de folga com 90 dias), escalados, liberados para troca, documentação em aberto; para cada um: **docs liberadas pelo cliente**, **integração** (feita/agendada/precisa integrar) e **Apto a entrar** só com os dois OK; chegada na obra. "Propor troca no canal interno".
- **Mobilização e agenda da IA**: datas (mobilização, viagem, início em campo, desmobilização), quem conduz (Rosana/Valéria), lista das perguntas agendadas/aguardando/respondidas com o motivo da data, feriados.
- **Participantes da missão** (`scanMail`, `scanWa`, `upsertPart`): cadastrados automaticamente a partir de quem aparece nos e-mails da missão (remetente, destinatário, **cópia**) e nas conversas de WhatsApp do time sobre a missão; nome/cargo pela assinatura; e-mails de setor marcados; cliente × terceiros pelo domínio; replicados no Prisma como contato participante da missão; "completar" o que falta.
- **Alertas desta missão** (comandos `@IA`/`/alerta`, ver 7.6).
- **Encerramento da missão** (ver 7.5).

### 6.8 Canal Interno e Gerencial (`gerOf`, `accessModal`, `histHTML`)
- **Interno**: só no sistema, nunca vai ao WhatsApp. Visual lilás tracejado. Equipe interna definida por missão.
- **Gerencial**: conversa à parte; **só a diretoria escolhe quem entra**. Visual azul. Contém o **Histórico comercial** do vendedor com o cliente (e-mails, ligações, videochamadas, WhatsApp, desde o primeiro contato).
- Ao adicionar alguém (Gerencial ou Interno): **"Compartilhar todo o histórico" ou "Só a partir de agora"**. Registro de quem entrou/saiu. Botão **"Ver como"** mostra exatamente o que a pessoa vê.

### 6.9 E-mails da missão (`linkReasons`, `mailCardHTML`, `threadModal`)
- Diretoria e gerentes veem **todos os e-mails de qualquer caixa** ligados à missão, **mesmo sem estar em cópia**: número da missão no assunto/texto, oportunidade/contrato/pedido citados, ou contato do domínio do cliente. Cada e-mail mostra o motivo do vínculo, a caixa de origem, "Ver conversa" (thread) e "Comentar no interno". Só leitura; quem responde é o dono da caixa.

### 6.10 RDOs e Relatórios técnicos (`RDOS`, `rdoListHTML`, `rdoDoc`, `REPORTS`, `reportsHTML`)
- **RDOs**: emitidos × assinados, lista com avanço de escopo, assinatura do líder de campo e do cliente, documento completo. RDO sem avanço de escopo marcado.
- **Relatórios técnicos**: cartões por tipo com quantidade; ao abrir o tipo, cada relatório tem **visualizar, baixar, enviar no WhatsApp, enviar no interno**.

### 6.11 Gestão (só gerentes e diretoria) (`acompTop`, `reviewHTML`, `mgmtHTML`, …)
Espelha o "sistema de acompanhamento" interno (os prints de referência ficam fora do repositório, por terem dados reais):
- Faixa: cliente, proposta, último RDO, início, término, segmento, alerta (prazo estourado/atrasado), **avanço do escopo** grande com marca do previsto.
- **Revisão semanal** com os 6 itens que o Otávio olha toda semana (calculados automaticamente em OK/Atenção/Crítico): **custos × avanço; meta da semana (ou global) cumprida; próxima meta (definir meta da semana seguinte ou ajustar meta global, opção de avisar o líder de campo no WhatsApp); RDOs em dia e assinados; desvios, NC e incidentes; medições e NFs**. "Concluir revisão" + histórico.
- **Consumo de gastos** (previsto × executado, traço do avanço, origem do custo: mão de obra, compras Omie, estoque, manuais; maiores gastos), **Evolução** (dias corridos, trabalhados, horas normais/HE, úteis, parados/standby, RDOs), **Composição do avanço** por serviço.
- **HH** contratado × previsto × consumido (espelho do sistema de ponto), **Dias trabalhados** (previstos na proposta × executados; regime **seg-sex** ou **seg-dom**; trabalho fora do regime listado com o status).
- **Avanço**: meta **semanal** (barras por semana) ou **global** (curva acumulada).
- **Prazo dos equipamentos em obra** (dias corridos desde a 1ª descarga confirmada, parcial/total, prazo da proposta, alerta de extensão com a regra de multa).
- **Romaneios e NFs/CT-e de transporte** (itens, transportadora, previsão, descarga).
- **Custos por categoria**, **RDOs**, **Faturamento** (medições, NFs), **Desvios, Incidentes, Não conformidades** com "Registrar".
- Tela **Revisão semanal** no trilho: todas as missões com os 6 indicadores e status Revisada/Pendente/Concluída.

### 6.12 Outros
- **Sino** de avisos internos (`notifsModal`), tema claro/escuro, modal de **Segurança** (especificação), tela **Chamadas** (gravações).

---

## 7. A IA da Central: todos os fluxos

### 7.1 Regras gerais
- Mensagens da IA vão **só para o canal Interno** (ou Gerencial, se o alerta foi criado lá), nunca para o WhatsApp — exceto quando o usuário pede explicitamente (ex.: "avisar o líder de campo no WhatsApp", cobrança de RDO, apresentação dos responsáveis).
- **Horário**: segunda a sexta, **08h às 18h**, fora de **feriados nacionais e municipais de Itajaí** (`HOLIDAYS`, `nextSlot`, `prevBiz`, `bizOnOrAfter`). Se cair fora, vai para o próximo horário útil. Feriado estadual de SC (16/08) e pontos facultativos **não** entram (Carnaval: decisão pendente). Feriados 2026 usados: 01/01, 03/04, 21/04, 01/05, 04/06 (Corpus Christi, municipal), 15/06 (aniversário de Itajaí), 07/09, 12/10, 02/11, 15/11, 20/11, 08/12 (Imaculada Conceição, municipal), 25/12. Fonte: feriadosapi.com — **conferir com a prefeitura** e manter em tabela editável.
- Toda resposta é feita **com botões e formulários curtos** dentro da própria mensagem da IA ("fácil e intuitivo").
- Todo **"não"/problema vira desvio automático** (`autoDev`) na Gestão e **marca a Qualidade e o gerente do contrato** no interno.

### 7.2 Criação da missão
| Gatilho | O que a IA faz |
|---|---|
| Grupo criado por **supervisor/gerente** (Wanderson, Gilmar, Jaqueline) | Pergunta a quem criou **quem é o vendedor da carteira** |
| Vendedor definido | Pede ao vendedor: **proposta técnica (arquivo), data prevista de atendimento, nome + e-mail + telefone do contato do cliente** (validados) e resumo opcional; repassa ao líder de projetos no interno |
| 2 h após criação (horário útil) | Pergunta ao líder de projetos **quem é o responsável pela documentação** |
| 2 h após criação, se o comercial não informou | Pede a **previsão de mobilização**, dias de viagem da proposta, quem conduz (Rosana/Valéria) e previsão de desmobilização |

### 7.3 Mobilização → campo (`agenda`, `ai2HTML`, `ai2Answer`)
| Quando | Pergunta | Se "não" |
|---|---|---|
| 5 dias úteis antes da mobilização | Etapas pendentes estão encaminhadas? | Risco → desvio |
| 1 dia útil antes | Mobilização confirmada para a data? | Pede nova data + motivo → desvio; repete 1 dia útil antes da nova data |
| Romaneio emitido | Avisa a **previsão de chegada** do equipamento; pede **confirmação de descarga**, data e se **todos os equipamentos** estão na obra ou foi **parcial** | Nova previsão; atraso > 2 dias → desvio |
| 1º dia útil após mobilização + dias de viagem | A equipe começou a trabalhar em campo? | Nova data + imprevisto → desvio |
| **Líder de campo escreve no grupo algo como "chegamos"** (`FIELD_RX`) | Pergunta ao líder de projetos se a equipe chegou: **todos / alguns / ninguém**. Se alguns: marcar quem está e **data de chegada de cada um que falta**; pergunta de novo nessas datas até completar | Nova previsão → desvio |

### 7.4 Execução
| Gatilho | Ação |
|---|---|
| **Todo dia às 7h**: RDO **sem avanço de escopo** | Pergunta ao líder de projetos: equipe parada (registra standby + desvio), faltou registrar (pede correção ao líder de campo no WhatsApp privado) ou está correto |
| RDO com trabalho **fora do regime** (ex.: sábado em proposta seg-sex) | Pergunta se foi **liberado internamente** (marca o gerente do contrato para ciência) ou **cobrar do cliente** → cliente formalizou? → e-mail ou WhatsApp? → contato de quem liberou → **procura e anexa a mensagem**; se não achar, pergunta para quem foi formalizado e pede o anexo; sem formalização → desvio |
| Mensagem nova de documentação (sistema de documentação) | Avisa no interno e atualiza a equipe |

### 7.5 Desmobilização e encerramento (`startClose`, fluxos `measure*`, `approvalCheck`, `nfRequest`, `omieClose`)
1. 1 dia útil antes da desmobilização: confirmada? **Total** ou **parcial** (marcar quem fica e por quê) ou **não** (nova data + motivo → desvio).
2. Equipamentos também desmobilizados? (não → previsão + desvio).
3. Chegada na sede confirmada? Para **cada colaborador**: sede, outra missão, folga direto ou férias direto, com data.
4. **Gerente do contrato marca/escreve que a operação terminou** → missão fica **"Pendente de medição"** → IA avisa o **Sérgio** para medir.
5. Sérgio não respondeu → no dia útil seguinte pergunta se já mediu. Não mediu → quando vai medir e previsão de aprovação.
6. Na data de aprovação → **aprovada pelo cliente?** (não → nova data + desvio).
7. Aprovada → **mediu o saldo completo?**
   - Sim → **liberada para faturamento** → pede à **Priscila** a emissão da NF.
   - Não → haverá outra medição? Sim → datas. Não → **por que não foi medido tudo** (registro) → **marca Gilmar (gerente comercial) e o gerente do contrato** com o valor faltante + desvio.
8. NF emitida → **"Aguardando últimos pagamentos (Omie)"** → IA pergunta à Priscila se ainda há despesas/pagamentos → quando não houver, **"Missão terminada"**.

### 7.6 Alertas personalizados por missão (`parseRule`, `checkRule`, `ralertHTML`)
- No Interno ou Gerencial, escrever começando com **`@IA`** ou **`/alerta`**. Ex.: *"@IA me notifique se nos RDOs não estiver vindo a informação de quantos metros de tubulação o cliente está liberando; se acontecer por dois dias seguidos, marque o líder de projetos"*.
- A IA mostra como entendeu (o que vigiar, quantos dias, quem marcar, em qual canal), o usuário **ativa**. Ao disparar: marca a pessoa citando os RDOs; respostas: "realmente não veio" (monitora mais N dias e pergunta de novo, indefinidamente), "vou cobrar o líder de campo", "veio mas você não encontrou" (a IA **aprende** a nova forma de escrever).
- No protótipo o entendimento é por regras simples; **no real deve ser um LLM** com saída estruturada (fonte, condição, janela, destinatário, canal, ação de repetição).

### 7.7 Detecção de participantes (ver 6.7) e e-mails da missão (6.9) também são tarefas da IA.

---

## 8. Permissões e perfis

| Recurso | Quem vê |
|---|---|
| Conversas de clientes | quem atende a linha/carteira (definir regra real) |
| Oportunidades / funil Prisma / propostas / valores | diretoria, vendedores, marketing, supervisores (`prismaUser`) |
| Bloco "No Prisma" no contato | todos |
| Grupo WhatsApp da missão | membros do grupo (campo e cliente incluídos) |
| Canal Interno | equipe interna da missão (com corte de histórico por pessoa) |
| Canal Gerencial + histórico comercial | só quem a **diretoria** adicionar (com corte de histórico) |
| E-mails da missão (todas as caixas) | **diretoria e gerentes cadastrados** (`canSeeMail`) |
| Aba Gestão / Revisão semanal | gerentes e diretoria (`canSeeMgmt`) |
| Definir participantes do Gerencial | diretoria; do Interno: diretoria e líder de projetos |

No real: **RLS no Postgres** (Supabase) por missão/canal/pessoa, nunca só no front.

---

## 9. Regras de negócio consolidadas

1. Conversa concluída sai de "Todas"; missão concluída fica em "Missões"; qualquer novidade de terceiros reabre.
2. Mensagem interna/gerencial **nunca** vai ao WhatsApp. Nenhum aviso automático ao cliente sem ação explícita.
3. IA só envia seg–sex 08–18h, fora de feriados nacionais e de Itajaí.
4. Prazo de equipamento em obra conta em **dias corridos** a partir da **descarga confirmada pelo líder de projetos** (não da emissão do romaneio); controlar parcial × total; multa por extensão não causada pela Filtrovali (valor na proposta).
5. Dia útil trabalhado = dia previsto na proposta trabalhado. Regime seg-sex: sábado/domingo trabalhado exige liberação interna ou cobrança formalizada.
6. Apto a entrar na obra = documentação liberada pelo cliente **e** integração feita.
7. Alerta de folga a partir de 80 dias em campo (90 dias é o limite).
8. Todo problema respondido à IA gera desvio e marca Qualidade + gerente do contrato.
9. E-mails entram na missão por número no assunto/texto, por códigos citados ou pelo domínio do cliente, independentemente de cópia.
10. Participantes externos detectados em e-mails/WhatsApp são cadastrados e replicados no Prisma.
11. Ao adicionar alguém em canal restrito, sempre escolher: todo o histórico ou só a partir de agora.
12. Tarefa concluída de missão avisa o grupo do WhatsApp (configurável).
13. E-mail sai com a assinatura digital de quem envia.

---

## 10. Integrações necessárias

| Sistema | Para quê | Como (recomendado) | Situação / risco |
|---|---|---|---|
| **WhatsApp** (20+ números WhatsApp Business App) — *revisto em 03/11/2026: Evolution com QR code, ver `docs/adr/0004-whatsapp.md`* | ler/enviar mensagens, grupos, arquivos, ligações | **WhatsApp Business Platform (Cloud API)**; verificar **coexistência** (app + API no mesmo número) número a número; webhook de mensagens | Bibliotecas não oficiais (espelhar WhatsApp Web) violam os termos e podem banir números — **não usar**. **Ligações atendidas no celular não podem ser gravadas pelo sistema**; só as que passarem pela Calling API/telefonia própria |
| **Microsoft 365** | Outlook (ler caixas da empresa, enviar com assinatura), SharePoint (pastas por cliente/missão), Teams (gravações e transcrições), login (Entra ID + MFA) | **Microsoft Graph** com app registrado no tenant da Filtrovali; permissões de aplicação limitadas por *application access policy* às caixas necessárias; webhooks (subscriptions) para e-mails novos | Exige consentimento do admin; comunicar a equipe (LGPD) que e-mails de missões ficam visíveis à gestão |
| **Prisma CRM** (feito pelo Otávio) | oportunidades, contato pessoa, contato CNPJ, feedback/histórico, participantes da missão, criar missão ao ganhar | API do Prisma (precisa de rotas para: criar feedback/histórico vinculado; upsert contato pessoa/CNPJ; vincular participante à missão; webhook "oportunidade ganha") | **Repositório/API ainda não analisados** — pedir ao Otávio |
| **Foco** (feito pelo Otávio) | tarefas, lote, notificações | API pública existente `/api/v1/tasks`, `/projects`, `/comments` + mesma base Supabase/login; reaproveitar `batch-task-parser.ts` e `smart-parse.ts` | Repositório analisado (TanStack Start + Supabase). Já há autorização PKCE com o Prisma |
| **Omie** | NFs, compras, romaneios(?), despesas e encerramento financeiro da missão | API Omie (app key/secret), sincronização por job | Confirmar onde nascem romaneios e NFs de transporte (CT-e) |
| **Sistema de documentação** | docs dos colaboradores, liberação pelo cliente, integração, validades | API ou leitura do banco | Sistema interno — levantar |
| **Sistema de acompanhamento** | avanço, custos, RDO, horas (print em referências) | API/banco (se for Supabase, ler direto) | Sistema interno — levantar |
| **Sistema de ponto** | HH consumido | espelhar via API/export | levantar |
| **App/fonte dos RDOs e relatórios técnicos** | ler RDOs diariamente, relatórios RCPU/RLQ/RTP… | API ou pasta SharePoint | levantar |
| **LLM (Claude API)** | todos os fluxos de IA: interpretar mensagens/RDOs/e-mails, resumos de chamadas, alertas por comando, extração de nome/cargo | Claude API com tool use / saída estruturada; nunca enviar dados além do necessário; logs | definir política de dados |
| **Transcrição de áudio** | ligações e reuniões | transcrição do Teams; para áudio próprio, serviço de STT | |

---

## 11. Arquitetura recomendada para a versão real

- **Mesma stack do Foco** para reaproveitar login, permissões e componentes: **TanStack Start + React + TypeScript + Tailwind 4 + Supabase (Postgres + RLS + Realtime + Storage + Edge Functions/cron)**, login **Microsoft (Entra ID)**, **PWA** primeiro; app nativo depois (Expo/React Native reaproveitando lógica).
- **Serviço de integrações** (backend) com:
  - webhooks de entrada (WhatsApp Cloud API, Microsoft Graph subscriptions, Prisma);
  - fila de jobs (ex.: `pg_cron` + tabela de jobs, ou worker dedicado) para a **agenda da IA** — cada pergunta agendada é uma linha com `run_at` já calculado pelo calendário útil;
  - calendário útil como função SQL/TS testada (portar `nextSlot`, `prevBiz`, `bizOnOrAfter`, `HOLIDAYS` para tabela).
- **Motor da IA**: máquina de estados por missão (`mission_ai_flows`: flow, state, payload, run_at, answered_by…) + LLM para interpretar texto livre. As respostas por botão gravam diretamente no estado (sem LLM).
- **Realtime**: Supabase Realtime para timeline e badges.
- **Arquivos**: SharePoint continua sendo a fonte; a Central só referencia e faz proxy de download com checagem de permissão.
- **Auditoria**: tabela imutável de eventos (quem viu/enviou/baixou/compartilhou).

---

## 12. Modelo de dados proposto

Entidades mínimas (nomes sugeridos):

- `people` (colaboradores: nome, cargo, nível `diretoria|gerente|...`, flags `seller`, `supervisor`, `docs`, e-mail, telefone, assinatura)
- `companies` (cliente/terceiro, CNPJ, domínios de e-mail, id no Prisma)
- `contacts` (pessoa externa: nome, cargo, e-mail, telefone, company_id, id no Prisma, origem)
- `whatsapp_lines` (os 20+ números, rótulo, quem atende)
- `conversations` (tipo `person|group|internal`, company_id, contact_id, line_id, mission_id, archived_by_user)
- `messages` (conversation_id, canal `wa|email|call|meet|note|internal|managerial|ai|event|stage`, direção, autor, texto, anexos, metadados, prisma_sync)
- `emails` (graph_id, caixa, thread, from/to/cc/bcc, assunto, corpo, anexos) + `email_mission_links` (motivo do vínculo)
- `calls` (gravação, duração, transcrição, resumo, tarefas sugeridas)
- `opportunities` (espelho do Prisma: código, título, etapa, temperatura, valor, vendedor)
- `missions` (número, company_id, opportunity_id, etapa, papéis: leader/manager/field/seller/docs/mob_coord, regime de trabalho, prazo contratado, valor do contrato, multa, plano: mobilização, viagem, desmobilização)
- `mission_members` (pessoa, canal `internal|managerial`, `history_since`)
- `mission_participants` (contatos externos detectados, fonte, kind cliente/terceiro, prisma_synced_at)
- `mission_crew` (colaborador de campo, status, docs liberadas pelo cliente, integração, validade, chegada, destino ao desmobilizar)
- `mission_stages_log`, `mission_ai_flows`, `mission_alert_rules`, `mission_alert_events`
- `rdos` (número, data, autor, equipe/horas, atividades de escopo, assinaturas) e `technical_reports` (tipo, número, arquivo)
- `romaneios` (itens, NF, CT-e, transportadora, previsão, descarga, parcial/total)
- `measurements`, `invoices`, `costs`, `hh_snapshots`, `weekly_goals`, `weekly_reviews`
- `deviations`, `incidents`, `nonconformities`
- `tasks` → **no Foco** (referência por id)
- `notifications`, `audit_log`, `holidays`

---

## 13. Segurança e LGPD

- Login único Microsoft (Entra ID) com **MFA**; bloquear ao desligar o colaborador.
- **RLS** por missão/canal/pessoa; corte de histórico (`history_since`) aplicado no banco.
- Criptografia em repouso e trânsito; dados no Brasil quando possível.
- **Gravação de chamadas**: aviso de gravação ao participante, retenção configurável, acesso restrito.
- **E-mails corporativos visíveis à gestão**: política interna escrita e comunicada; registrar quem abriu cada e-mail.
- Trilha de auditoria imutável; alertas de risco (download em massa, envio de arquivo para fora).
- Segredos só em variáveis de ambiente/cofre. ⚠️ **O zip do Foco enviado continha um `.env` com chaves do Supabase** — remover do repositório/compartilhamentos e girar as chaves se o arquivo circulou.
- LLM: enviar só o mínimo necessário, sem treinar com dados da empresa; registrar prompts/respostas para auditoria.

---

## 14. Como o código do protótipo está organizado

Arquivo único `prototipo/index.html`:

1. `<style>`: tokens de cor (`:root` claro, dark por `prefers-color-scheme` e `[data-theme]`), layout em grid (trilho 64px | lista 340px | conversa | painel 370px), componentes, responsivo (`max-width:1200px` painel vira gaveta; `max-width:760px` uma tela por vez).
2. `<svg>` com os ícones (`<symbol id="i-…">`).
3. Marcação base: `.app` com `nav.rail`, `aside#list`, `main#chat`, `aside#info`, `#toasts`, `#overlay`.
4. `<script>` (IIFE), em blocos comentados `/* ---------- … ---------- */`:
   - **Dados de exemplo**: `TEAM`, `LINES`, `STAGES`, `OPPS`, `CLIENT_FILES`, `TASKS`, `CONVS` (cada conversa com `items[]` da timeline), `MGMT`, `ACOMP`, `RDOS`, `LOGI`, `REPORTS`, `SHIST`, `WA_SCAN`, etc.
   - **Estado** `S` (view, filtro, conversa ativa, canal por conversa, rascunhos, camadas, anexos…).
   - **Módulos**: parsing de tarefas/lote, missões, IA de ciclo, logística, encerramento, gerencial/acesso, alertas, Prisma, e-mail Outlook, participantes.
   - **Render**: `renderList`, `renderChat` (→ `streamHTML` → `itemHTML`), `renderInfo` (→ `resumoHTML`, `filesPanelHTML`, `tasksPanelHTML`, `journeyHTML`), `renderAll`.
   - **Ações**: um único `document.addEventListener("click")` com `switch` sobre `data-act`; `change`/`input` delegados; arrastar (SharePoint e deslizar).
   - `push(c,item)` é o ponto central para adicionar itens à timeline (reabre arquivadas, sincroniza Prisma, detecta participantes).
   - Datas simuladas: hoje fixo em **25/10/2026** (`BASE`, `NOW`), semana `S43`.
- Limitações conhecidas: tudo em memória; regras de IA por regex/palavras-chave; o código cresceu por camadas (há duplicações e alguns `innerHTML` grandes) — **serve como especificação visual e funcional, não como base de código de produção**. A versão real deve ser reescrita em componentes React com a stack do Foco.

---

## 15. Dados fictícios (trocar pelos reais)

Clientes, missões, valores, RDOs, romaneios, custos, HH, desvios, e-mails e telefones são inventados. Pessoas inventadas ou com **sobrenome inventado**: Priscila/Lívia Dantas (engenharia), Fernando Viana, Bruna Aguiar, Murilo Fonseca, Laércio Galvão, Pedro Augusto e Pedro Bueno (cargos), Marina Brandão (líder de projetos), Renata Teodoro, Débora Falcão (qualidade), Sabrina Cardoso (documentação), Tereza Lessa (diretoria), Rosana Siqueira, Valéria Lima, Sérgio Rezende, Priscila Lacerda, Davi Paiva, Josué Souza, Ana Clara Ramos, Caetano Pimentel, Ronaldo Lessa, Wanderson Costa, Gilmar Macedo, Jaqueline Pacheco; equipe de campo (Nilton, Cristiano, Edson, Heitor, Carlos, Dênis, Hélio, Mauro, Caetano Sampaio, Bruno, Enzo, Ivan, Paulo). Do print do Prisma aparecem nomes reais de vendedores (ex.: Davi Casas, Ronaldo Oliveira, Ana Barcelos, Caetano Silva, Josué Jonatha Correia) — usar o cadastro real.

---

## 16. Decisões em aberto

1. Lista real das **etapas da missão** (na ordem) que o líder de projetos preenche.
2. Significado e lista completa das siglas de **relatórios técnicos** (RCPU, RLQ, RTP, …).
3. **Carnaval** conta como dia sem mensagens da IA?
4. Nome real do **responsável da qualidade** e da equipe de **documentação**.
5. "Data prevista para atendimento" (vendedor) e "previsão de mobilização" são a mesma informação?
6. **Terceiros** (hotel, fornecedores) também devem ser replicados no Prisma ou só contatos do cliente?
7. Unidade da **meta semanal** por tipo de serviço (horas de máquina, litros, % físico…).
8. Situação de cada um dos **20+ números** de WhatsApp (app × API, coexistência).
9. Rotas da **API do Prisma** e acesso ao repositório.
10. Onde nascem **romaneios** e **NFs/CT-e de transporte** (Omie ou outro).
11. Origem dos **RDOs** e do **sistema de acompanhamento** (é Supabase? tem API?).
12. Valor/regra exata da **multa** de equipamentos por proposta (vem do Prisma?).
13. Assinaturas de e-mail dos demais colaboradores (foto, cargo, telefone) e imagens oficiais dos selos ISO 9001/GPTW.
14. Regra de **quem vê quais conversas de clientes** (por linha, por carteira, por missão).

---

## 17. Próximos passos

**Fase 0 — Preparação (1 semana)**
- [ ] Validar o protótipo com o time (abrir `prototipo/index.html`) e responder as decisões em aberto (seção 16).
- [ ] Obter acesso: tenant Microsoft 365 (app no Entra ID), Meta Business (WhatsApp Cloud API), repositório/API do Prisma, Omie, sistemas de documentação/acompanhamento/ponto.
- [ ] Girar as chaves do Supabase que estavam no `.env` do Foco.

**Fase 1 — Fundação**
- [ ] Criar o projeto com a stack do Foco (TanStack Start + Supabase + Tailwind + Poppins + tokens de `identidade-visual/design-system/tokens.json`).
- [ ] Login Microsoft com MFA, tabela `people`, perfis e RLS.
- [ ] Layout em 3 colunas + mobile (portar do protótipo), tema claro/escuro.
- [ ] Modelo de dados da seção 12 (migrations).

**Fase 2 — Microsoft 365**
- [ ] Ler e-mails por contato e por missão (Graph + subscriptions), responder/enviar com Para/Cc/Cco, @menção, anexar e-mail, assinatura por pessoa.
- [ ] SharePoint: pasta por cliente/missão, navegação, anexar na conversa.
- [ ] Teams: reuniões, gravações e transcrições ligadas à conversa.

**Fase 3 — WhatsApp oficial**
- [ ] Migrar/conectar os números à Cloud API (começar por 1–2 números piloto), webhooks, grupos de missão, linhas por usuário.
- [ ] Ligações: definir o que é viável gravar (Calling API) e o aviso LGPD.

**Fase 4 — Foco e Prisma**
- [ ] Tarefas via API do Foco (`/tarefa`, lote com o parser do Foco, delegar em lote, avisos no grupo).
- [ ] Prisma: bloco no contato, registrar feedback/histórico, contatos pessoa/CNPJ, participantes da missão, criação automática da missão/grupo ao ganhar a oportunidade.

**Fase 5 — Missões**
- [ ] Canais Interno e Gerencial com corte de histórico e "ver como".
- [ ] Responsáveis, etapas, equipe/acesso/integração (sistema de documentação), E-mails da missão (todas as caixas, por regra de vínculo).
- [ ] RDOs e relatórios técnicos.

**Fase 6 — IA**
- [ ] Calendário útil + feriados (tabela) + agenda de jobs.
- [ ] Máquina de estados dos fluxos da seção 7 (criação → mobilização → campo → desmobilização → medição → faturamento → Omie).
- [ ] Leitura diária de RDOs, detecção de chegada no grupo, alertas por comando `@IA` (LLM com saída estruturada), detecção de participantes, resumos de chamadas.

**Fase 7 — Gestão**
- [ ] Integrar sistema de acompanhamento, Omie e ponto; aba Gestão, revisão semanal, tela de revisão de todas as missões.

**Fase 8 — Endurecimento e app**
- [ ] Auditoria, alertas de risco, política LGPD, testes de permissão (RLS), backup.
- [ ] PWA instalável e notificações push; depois app nativo.

**Sugestão de primeira tarefa no Claude Code:** "Leia INSTRUCOES.md e CLAUDE.md, abra prototipo/index.html para entender a interface e proponha o esqueleto do projeto real (Fase 1) com a stack do Foco, incluindo migrations das tabelas da seção 12 e as políticas RLS da seção 8."

---

## 18. Links

- Protótipo publicado (privado): https://claude.ai/artifact/4xSL5TF2xJ8S57tK9TNe7f
- Design System Filtrovali (privado): https://claude.ai/artifact/Bsp4jajvvvmWbmE8kDuwR4
- Feriados de Itajaí 2026 (fonte usada): https://feriadosapi.com/calendario/2026/SC/4208203
