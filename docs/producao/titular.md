# Pedidos do titular (LGPD, art. 18)

Entrega E15. Como atender quem pede acesso, correção, eliminação ou informação sobre os próprios
dados no Omni. Canal único: **privacidade@filtrovali.com.br** (encarregado de dados).

## Prazos e registro

- **Confirmação de existência ou acesso:** resposta simplificada na hora ou declaração completa em
  até **15 dias** do pedido (art. 19).
- **Antes de responder, confira a identidade** de quem pede. Use o próprio e-mail ou telefone de que
  vieram os dados, ou peça um documento. Nunca mande dados a um endereço diferente do titular.
- Registre cada pedido (data, quem pediu, o que pediu, o que foi feito e quando) na pasta do
  encarregado, junto das evidências de `lgpd-ropa-dpa.md`.

## 1. Quem usa o Omni (colaboradores)

**Acesso:** a própria pessoa baixa os dados em **Meu perfil → Baixar meus dados**. Isso gera um arquivo
JSON montado por `app.meus_dados()` (migration 0082) e registra o pedido na auditoria
(`dados.exportados`). O arquivo traz:
- perfil, perfis de acesso e funções;
- aceites do termo, sessões e aparelhos com notificação;
- preferências e chaves de API (sem a chave);
- tarefas, comentários e mensagens que a pessoa escreveu nos canais;
- avisos;
- e-mails e mensagens de WhatsApp enviados pelo Omni e e-mails abertos no Omni;
- números de WhatsApp, ligações (com resumo e transcrição), pastas pessoais, alertas de risco e o
  registro de ações.

**Fica de fora do arquivo, e por quê:**
- **Segredos:** hash de sessões e de chaves, chave das gravações, endereço de notificação, token do
  Prisma.
- **Dados de outras pessoas:** o que outras pessoas escreveram nos canais e as conversas do WhatsApp,
  que também são de quem conversou com a pessoa.
- **Dados que vivem em outro sistema:** os e-mails estão no Microsoft 365, e missões e RDOs estão no
  filtroAPP.

Se a pessoa pedir isso, o encarregado avalia caso a caso. O histórico do WhatsApp do próprio número
ela já vê no Omni.

**Correção:** nome, cargo e telefone vêm do Entra (Microsoft 365). Corrija lá, e o Omni atualiza no
próximo login ou na leitura de hora em hora. Perfis e funções se corrigem em Administração.

**Eliminação de quem sai da empresa:**
1. Desative a pessoa em Administração → Pessoas, ou tire-a do app "Omni" no Entra.
2. As sessões caem na hora.
3. As tarefas pessoais vencem 2 anos depois (`retencao.md`).
4. O resto segue o prazo de cada dado.

Apagar antes do prazo só por decisão do encarregado. Antes, confira se há obrigação de guardar
(trabalhista, contrato com o cliente, defesa em processo; art. 16).

## 2. Quem é de fora (clientes, fornecedores, contatos)

O Omni guarda dados de terceiros nos lugares abaixo. Para levantar o que há sobre alguém, use o
e-mail e o telefone que o titular informou. Os comandos são **só leitura** e rodam na VPS como
`omni_owner`. O telefone vai só com dígitos, no formato `5547999990000`.

```bash
docker exec -i omni-postgres-1 psql -U omni_owner -d omni -v email="'fulano@cliente.com.br'" -v tel="'5547999990000'" <<'SQL'
-- Agenda da empresa (contato e identidades)
SELECT c.name, c.company, c.role, i.kind, i.value, i.source, c.created_at
  FROM contacts c JOIN contact_identities i ON i.contact_id = c.id
 WHERE c.id IN (SELECT contact_id FROM contact_identities WHERE lower(value) IN (lower(:email), :tel));
-- Assinatura lida dos e-mails e telefones citados
SELECT * FROM email_signature_extractions WHERE lower(address) = lower(:email);
SELECT * FROM contact_phone_hints WHERE lower(address) = lower(:email) OR phone = :tel;
-- Participantes das missões (nome, cargo, empresa preenchidos à mão)
SELECT mission_id, nome, cargo, empresa, lado, updated_at FROM mission_participant_notes WHERE lower(chave) IN (lower(:email), :tel);
-- E-mails ligados a missões e cabeçalhos das caixas pessoais (quantidade e período)
SELECT count(*), min(received_at), max(received_at) FROM mail_messages
 WHERE lower(from_address) = lower(:email) OR to_recipients::text ILIKE '%' || :email || '%' OR cc_recipients::text ILIKE '%' || :email || '%';
SELECT count(*), min(received_at), max(received_at) FROM mail_items WHERE lower(:email) = ANY (addresses);
-- WhatsApp: conversas e mensagens guardadas no Omni, ligações com a pessoa
SELECT ch.id, ch.name, ch.is_group, count(m.*) AS mensagens, min(m.sent_at), max(m.sent_at)
  FROM whatsapp_chats ch LEFT JOIN whatsapp_messages m ON m.chat_id = ch.id
 WHERE ch.phone = :tel GROUP BY ch.id;
SELECT count(*), min(started_at), max(started_at), count(*) FILTER (WHERE recording) AS gravadas
  FROM whatsapp_calls WHERE peer LIKE '%' || :tel || '%';
SQL
```

**Fora do Omni, os mesmos dados também estão em:**
- e-mails completos: Microsoft 365;
- conversas completas: no WhatsApp de cada número e na Evolution do Omni;
- contatos comerciais: Prisma.

O pedido inteiro passa por esses sistemas também.

**O que responder:** quais tipos de dado existem, de onde vieram, para quê (finalidade e base legal
no ROPA, `lgpd-ropa-dpa.md`), com quem são compartilhados (operadores) e por quanto tempo ficam
(`retencao.md`).

**Correção:** contato e participante se corrigem pela tela, por quem tem acesso (agenda da empresa,
seção Participantes da missão).

**Eliminação:** avaliar com a diretoria se há base para continuar guardando, como contrato em
andamento ou obrigação legal (art. 16). Se não houver:
1. Apague o contato da agenda (`contacts`; as identidades saem junto).
2. Apague as linhas em `email_signature_extractions` e `contact_phone_hints` do endereço.
3. Conversas e e-mails seguem a retenção da missão. Apagar antes do prazo é decisão do encarregado,
   registrada, e feita no banco como `omni_owner`, com backup do dia.

## 3. Oposição e revisão de decisão automatizada

- A IA do Omni **sugere** (perguntas, alertas, resumos). Quem decide é sempre uma pessoa, então não há
  decisão só automatizada no sentido do art. 20.
- Se alguém se opuser ao uso da IA sobre dados seus, desligue a leitura da assinatura dos e-mails
  dele: apague a linha em `email_signature_extractions`. O encarregado avalia o resto.
