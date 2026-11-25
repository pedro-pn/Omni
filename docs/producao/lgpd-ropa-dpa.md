# LGPD do Omni: ROPA, contratos com operadores e comunicação ao time

> Escrito em 04/11/2026. Pendência nº 6 — obrigatória antes de ligar em produção a leitura de e-mails, a IA e o WhatsApp.
> Quem faz: **encarregado de dados** (`privacidade@filtrovali.com.br`), com aprovação da **diretoria**. Este documento é um roteiro operacional: as bases legais e os textos devem ser validados pelo encarregado e, se houver, pelo jurídico.

## Visão geral

| # | Entrega | Quem | Antes de ligar em produção |
|---|---|---|---|
| 1 | Registrar no ROPA as operações de tratamento do Omni | Encarregado | Tudo |
| 2 | Ter o contrato de tratamento de dados (DPA) de cada operador, com o mecanismo de transferência internacional | Encarregado / diretoria | E-mails, SharePoint, IA |
| 3 | Política interna escrita e **comunicada** ao time (e-mails visíveis à gestão, IA, WhatsApp) | Diretoria + encarregado | Leitura de e-mails e IA |
| 4 | Relatório de impacto (RIPD) e teste de legítimo interesse das operações de maior risco | Encarregado | Leitura de e-mails e IA |
| 5 | Atualizar o aviso de privacidade externo (site) | Encarregado / marketing | WhatsApp e IA com clientes |
| 6 | Guardar as evidências | Encarregado | Sempre |

---

## 1. ROPA — o que registrar

Use o modelo de registro de operações que a Filtrovali já mantém. Uma linha por operação:

| Operação | Finalidade | Titulares | Dados | Base legal (sugestão, validar) | Operadores | Retenção (sugestão) |
|---|---|---|---|---|---|---|
| Canais Interno e Gerencial das missões | Coordenar a execução das missões | Colaboradores | Nome, e-mail, mensagens, anexos | Execução de contrato (art. 7º, V) e legítimo interesse (art. 7º, IX) | Provedor da VPS do Omni | Enquanto a missão existir + prazo do contrato com o cliente |
| Leitura de e-mails ligados às missões (Microsoft 365) | Reunir num lugar a comunicação da missão | Colaboradores, contatos de clientes e fornecedores | Remetente, destinatários, assunto e prévia (o Omni guarda só os e-mails ligados a missões; corpo e anexos ficam no Microsoft 365 e são lidos na hora de abrir) | Legítimo interesse (art. 7º, IX) — **exige RIPD e comunicação ao time** | Microsoft | Igual à do e-mail na caixa de origem |
| Pastas comerciais do SharePoint (leitura) | Consultar propostas e documentos da missão | Contatos de clientes | Documentos comerciais | Execução de contrato e procedimentos preliminares (art. 7º, V) | Microsoft | A do SharePoint (o Omni não copia os arquivos) |
| IA do ciclo da missão, leitura de RDOs, alertas pedidos à IA (@IA, /alerta) e resumo de reuniões do Teams (OpenAI) | Perguntas automáticas, alertas e resumos | Colaboradores, contatos de clientes | Texto dos RDOs, mensagens enviadas à IA e transcrições de reuniões ligadas à missão (a transcrição não fica no Omni; só o resumo) | Legítimo interesse — **exige RIPD**; minimização | OpenAI (EUA) | OpenAI: retenção zero (ativada); no Omni: metadados da chamada, sem o texto |
| Resumo das ligações gravadas do WhatsApp (OpenAI; autorizado em 10/11/2026) | Resumo, combinados e pendências da ligação para quem já ouve a gravação | Colaboradores e contatos (clientes, fornecedores) que falaram na ligação | Áudio da gravação (só de ligações que a pessoa escolheu gravar, com aviso aos participantes, e só quando o dono pede o resumo); a transcrição e o resumo ficam no Omni junto da gravação (desde 13/11/2026), visíveis só para quem a ouve | Legítimo interesse — **exige RIPD**; minimização (só ligações gravadas; excluir a gravação apaga a transcrição e o resumo) | OpenAI (EUA) | OpenAI: retenção zero (ativada); no Omni: a transcrição e o resumo seguem a retenção da gravação e somem com ela. Gravações: 5 anos (decisão de 11/11/2026, `CHAMADA_RETENCAO_HORAS`), ou até o dono excluir. Ficam no SharePoint da Filtrovali (site OmniAnexos), em M4A **cifrado** com uma chave por gravação guardada só no Omni: nem os administradores do Microsoft 365 conseguem ouvir. Excluída, a chave é apagada na hora (a gravação fica ilegível mesmo com cópias) e o arquivo é apagado de vez; vencida, idem. Os backups do banco guardam a chave por até 14 dias. Chave mestra (`GRAVACOES_CHAVE_MESTRA`) com cópia no cofre da TI |
| Nome, cargo, empresa e telefone pela assinatura dos e-mails (OpenAI; autorizado em 10/11/2026 para as missões e ampliado em 24/11/2026 para os remetentes externos das caixas pessoais) | Saber quem é quem do cliente e dos terceiros e ligar o e-mail ao WhatsApp do mesmo contato | Contatos externos que escreveram e-mails ligados a missões ou para a caixa pessoal de quem usa o Omni | Só o final do e-mail mais recente de cada remetente externo (a assinatura, sem a conversa citada); o texto não fica no Omni, só nome, cargo, empresa e telefone conferidos no texto | Legítimo interesse — **exige RIPD**; minimização (um e-mail por remetente, só o trecho final) | OpenAI (EUA) | OpenAI: retenção zero; no Omni: os campos extraídos, refeitos a cada 180 dias; visíveis só para quem vê os e-mails e o Interno da missão |
| Caixa única: cabeçalhos dos e-mails da caixa pessoal (0067) | Juntar e-mail e WhatsApp por contato e avisar de e-mail novo | Colaboradores e quem escreve para eles | Remetente, destinatários, assunto, prévia (300 caracteres), datas e lido, da Entrada e dos Enviados; **sem o corpo**; só o dono lê (`mail_items`) | Execução do contrato de trabalho / legítimo interesse | Microsoft (já operador) | Definir (sugestão: janela de 90 dias da leitura + 1 ano) |
| Telefones citados no corpo dos e-mails (0076) | Sugerir o telefone do contato | Remetentes externos | Números com formato de telefone no texto do próprio e-mail (sem a conversa citada), achados no Omni, sem IA; só sugestão, vincular é um clique; visíveis só para quem troca e-mails com o remetente (`contact_phone_hints`, `app.telefones_do_correspondente`) | Legítimo interesse | — | Refeitos com a leitura da assinatura (180 dias) |
| Agenda de contatos da empresa (0067–0068) | Ligar e-mail e telefone do mesmo contato | Clientes, parceiros, terceiros | Nome, empresa, cargo, e-mails e telefones vinculados por alguém do Omni ou, sozinho, o celular da assinatura do e-mail (já extraída, 0044) (`contacts`, `contact_identities` com a origem); recusas de sugestão por pessoa; contato de cliente vai ao Prisma por clique | Legítimo interesse | — | Enquanto houver relação comercial |
| Aba E-mails (caixa da própria pessoa) | Ler e responder os próprios e-mails dentro do Omni | Colaboradores e quem escreve para eles | Pastas, cabeçalhos, corpo e anexos lidos na hora no Microsoft 365; **nada guardado no Omni**; envios registrados em `mail_outbox` | Execução do contrato de trabalho / legítimo interesse | Microsoft (já operador) | Sem retenção no Omni (só o registro de envio) |
| Alertas de risco (Fase 11) | Notar cópia em massa de arquivos ou envio de arquivos para fora | Colaboradores | Registro de cada download intencional (origem e id do arquivo, data, pessoa) em `audit_log`; contagem de anexos enviados para fora (`mail_outbox`, `whatsapp_outbox`); alertas em `risk_alerts` (só Administração e diretoria) | Legítimo interesse (segurança da informação), informado no termo de uso | — | Seguir a retenção dos logs (sugestão: 365 dias) |
| WhatsApp pela Evolution | Atender clientes e equipes de campo | Clientes, colaboradores | Telefone, nome, mensagens, mídia; endereço da foto do perfil (a imagem não é guardada, é lida no WhatsApp quando alguém que vê o número abre a lista) | Execução de contrato e legítimo interesse | Provedor da VPS (a Evolution roda em servidor próprio); o WhatsApp/Meta é controlador da própria plataforma | Definir (sugestão: 5 anos, prazo de garantia/obra) |
| Histórico do WhatsApp no aparelho | Ler o histórico das próprias conversas no Omni (como o WhatsApp Web) | Colaborador dono do número e quem conversa com ele | Mensagens de antes do pareamento: ficam na Evolution do Omni (servidor próprio) e são baixadas só para o navegador do dono (IndexedDB); o banco do Omni guarda só a conversa (nome, data, prévia da última) | Legítimo interesse / execução do contrato de trabalho | Provedor da VPS | No aparelho até a pessoa sair do Omni ou remover o número; na Evolution enquanto o número estiver conectado |
| Tarefas (absorção do Foco) | Organizar o trabalho | Colaboradores | Tarefas, comentários, anexos | Execução de contrato de trabalho / legítimo interesse | Provedor da VPS; Microsoft (anexos no SharePoint) | Enquanto a pessoa estiver na empresa + 2 anos |
| Integrações filtroAPP e Prisma | Ler dados de missões e oportunidades | Colaboradores, contatos de clientes | Os já registrados nesses sistemas | As do sistema de origem | — (sistemas próprios) | A do sistema de origem |
| Notificações no celular e no computador (Web Push, app instalável) | Avisar de mensagens, alertas, perguntas da IA e tarefas | Colaboradores | Título e prévia curta (até 120 caracteres) da mensagem ou aviso, endereço do aparelho | Legítimo interesse; a pessoa ativa por aparelho e escolhe o que recebe | Serviços de push do navegador (Google, Apple, Mozilla): o conteúdo vai **cifrado de ponta a ponta** e eles não o leem | Inscrição removida ao sair do Omni, ao desativar ou quando o aparelho deixa de existir |
| Login e auditoria | Segurança e rastreabilidade | Colaboradores | E-mail, nome, IP, ações | Cumprimento de obrigação e legítimo interesse | Microsoft (Entra) | 6 meses (logs de acesso, Marco Civil art. 15) ou mais, se a política interna pedir |

Para cada linha, registre também as **medidas de segurança** (comuns a todas): login Microsoft com MFA, permissão no banco por missão e pessoa (RLS), dados em trânsito por HTTPS, segredos fora do código, trilha de auditoria.

## 2. Operadores e contratos (DPA)

| Operador | O que trata | Contrato | Transferência internacional | Ação |
|---|---|---|---|---|
| **Microsoft** (M365, Entra, Graph) | E-mails, agenda, Teams, SharePoint, login | **Microsoft Products and Services DPA**, já incluído no contrato do Microsoft 365 | Sim (pode haver processamento fora do Brasil) | Baixar a versão vigente no Microsoft Service Trust Portal, anexar ao ROPA e conferir a residência de dados do tenant (Centro de administração → Configurações → Perfil da organização → Local dos dados) |
| **OpenAI** (API) | Texto enviado à IA | **Data Processing Addendum** da OpenAI (formulário em https://openai.com/policies/data-processing-addendum, preenchido com a organização da API da Filtrovali) | Sim (EUA) | Assinar o DPA com a organização da Filtrovali; guardar a confirmação da **retenção zero** (já ativada) |
| **Provedor da VPS** onde o Omni roda | Banco do Omni, worker, Evolution | Termos/DPA do provedor | Conforme a localização do servidor | Anexar o DPA; preferir servidor no Brasil |
| **Meta/WhatsApp** | — | Não é operador da Filtrovali na Evolution (QR code); os termos do WhatsApp Business se aplicam ao uso do número | — | Registrar no ROPA o risco aceito (ADR 0004) |

**Transferência internacional (art. 33 da LGPD):** confira se o DPA de cada operador fora do Brasil traz um mecanismo válido — em especial as **cláusulas-padrão contratuais da ANPD** (Resolução CD/ANPD nº 19/2024) ou outro previsto no art. 33. Se o DPA trouxer só as cláusulas da União Europeia, registre a análise e a decisão do encarregado.

## 3. Política interna e comunicação ao time

A INSTRUCOES (§13) exige: **e-mails ligados a missões ficam visíveis à gestão**, com política escrita e comunicada, e registro de quem abriu cada e-mail.

### Passo a passo

1. A diretoria aprova o texto abaixo (ajustado pelo encarregado).
2. Envio por e-mail a todos os usuários do Omni (e a quem tiver a caixa no grupo `Omni - Caixas`), **com confirmação de leitura**, antes de ligar a leitura de e-mails em produção.
3. O texto fica publicado no Omni (link no rodapé) e na intranet.
4. Novos colaboradores recebem o texto no primeiro acesso: a página `/termos` do Omni mostra o termo de uso e privacidade (`packages/core/src/termos.ts`) e só libera o Omni depois do aceite. O texto da página deve ser validado pelo encarregado junto com este comunicado.
5. Guardar as confirmações de leitura (ver item 6).

### Modelo de comunicado

> **Assunto: Omni — como os dados da sua comunicação de trabalho são usados**
>
> A partir de [data], a Filtrovali passa a usar o Omni, que reúne num só lugar a comunicação das missões e dos clientes. Para isso:
>
> 1. **E-mails ligados a missões** das caixas incluídas no Omni ficam visíveis, dentro do Omni, para a diretoria e os gerentes cadastrados. Só e-mails ligados a missões (pelo número da missão, códigos citados ou domínio do cliente) entram. Cada abertura de e-mail fica registrada.
> 2. **Pastas do SharePoint** de oportunidades e missões aparecem no Omni para quem já tem direito a elas pelo perfil.
> 3. **Assistente (IA):** o Omni usa a API da OpenAI para ler RDOs e mensagens enviadas a ele e sugerir perguntas e alertas, para resumir a transcrição das reuniões do Teams que citam uma missão para ler nome, cargo e empresa na assinatura dos e-mails de quem escreve sobre uma missão, e para resumir, quando o dono da gravação pede, as ligações do WhatsApp que ele escolheu gravar (a transcrição não fica guardada no Omni, só o resumo; excluir a gravação apaga o resumo). O provedor não guarda nem usa esses dados para treinar modelos (retenção zero contratada). A IA sugere; quem decide é sempre uma pessoa.
> 4. **WhatsApp:** os números da empresa conectados ao Omni ficam registrados nele. Mensagens internas e gerenciais nunca saem pelo WhatsApp.
> 5. Base legal, prazos e seus direitos (acesso, correção, informação) estão na política de privacidade interna: [link]. Dúvidas: privacidade@filtrovali.com.br.

## 4. Relatório de impacto (RIPD) e legítimo interesse

Para a **leitura de e-mails** e a **IA**, que se apoiam em legítimo interesse e envolvem monitoramento de comunicação, o encarregado deve:

1. Fazer o **teste de legítimo interesse** (finalidade legítima, necessidade, balanceamento com as expectativas do titular, salvaguardas).
2. Elaborar o **RIPD** (art. 38) com: descrição do tratamento, dados e titulares, riscos (acesso indevido, exposição de dados pessoais em e-mails, envio a operador fora do Brasil), medidas (RLS, MFA, auditoria, retenção zero, minimização, corte de histórico).
3. Registrar a decisão da diretoria.

## 5. Aviso de privacidade externo

Atualizar o aviso do site para clientes e fornecedores: uso de WhatsApp e e-mail no atendimento, uso de IA com provedor contratado e o canal do encarregado.

## 6. Evidências a guardar

| Evidência | Onde guardar |
|---|---|
| ROPA atualizado (versão e data) | Pasta do encarregado |
| DPA da Microsoft e da OpenAI (PDF/confirmação) e análise de transferência internacional | Pasta do encarregado |
| Confirmação da retenção zero da OpenAI | Pasta do encarregado |
| Texto aprovado da política + confirmações de leitura | Pasta do encarregado / RH |
| Aceites do termo de uso no Omni (versão, SHA-256 do texto, data, IP, navegador) | Tabela `terms_acceptances` do Omni (Administração → Pessoas mostra quem aceitou) e `audit_log` (`termos.aceitos`) |
| RIPD e teste de legítimo interesse assinados | Pasta do encarregado |

Quando tudo estiver pronto, marque o item correspondente em `docs/producao/entrada-em-producao.md`.
