# Plano de resposta a incidentes do Omni

> 16/11/2026 (Fase 11). Roteiro operacional; prazos legais e textos de comunicação
> devem ser validados pelo **encarregado de dados** (`privacidade@filtrovali.com.br`)
> e, se houver, pelo jurídico. Comandos para a VPS de produção (`~/apps/Omni`, usuário `omni`).

```bash
C="docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production"
SQL() { $C exec -T postgres psql -U postgres -d omni -c "$1"; }
```

## 1. O que é incidente

- Acesso indevido a dados (conta comprometida, pessoa vendo o que não devia, vazamento).
- Alerta de risco confirmado (Administração → Segurança: download em massa, arquivos para fora).
- Segredo exposto (`.env.production`, certificado do Graph, chave das gravações, token de API).
- Número de WhatsApp pareado sem autorização ou banido; caixa de e-mail usada indevidamente.
- Perda de dados (banco, gravações) ou indisponibilidade prolongada.

## 2. Papéis

| Papel | Quem | Faz |
|---|---|---|
| Responsável técnico | quem administra a VPS do Omni | contém, investiga, recupera, registra |
| Encarregado de dados | `privacidade@filtrovali.com.br` | avalia o risco aos titulares, decide e faz as comunicações |
| Diretoria | — | aprova comunicações e medidas com impacto no negócio |

## Como um incidente costuma chegar

- **Aviso "Erro no Omni" no sino ou no celular** (quem tem o perfil admin): erro inesperado no web,
  num job do worker ou no backup. Detalhes, versão e pilha em Administração → **Erros**. O mesmo
  erro só avisa de novo depois de 6 h e se voltar a acontecer; marque como visto depois de resolver.
- **Backup:** o worker confere de hora em hora o status do backup (`OPERACAO_STATUS=ligado`) e avisa
  se o último envio ao B2 passar de 26 h, se uma execução falhar ou se o ensaio de restauração passar
  de 35 dias (`docs/producao/backup.md`).
- **Logs e saúde:** Administração → **Saúde** e o Grafana Cloud (`docs/producao/logs.md`).

## 3. Conter (primeira hora)

1. **Conta comprometida ou pessoa que saiu:** desative a pessoa no Entra (tire do grupo
   do app "Omni") — o job `entra-pessoas` desativa no Omni e encerra as sessões em até 1 h.
   Para encerrar já: Administração → Pessoas → Desativar, ou
   `SQL "UPDATE sessions SET revoked_at = now() WHERE person_id = '<id>' AND revoked_at IS NULL"`.
2. **Todas as sessões** (suspeita no login): `SQL "UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL"`
   — todo mundo entra de novo pela Microsoft. (Trocar o `AUTH_SECRET` **não** encerra sessões —
   o banco guarda só o SHA-256 do token — e inutiliza as credenciais cifradas do Prisma e os
   endereços das imagens dos e-mails: só troque se ele próprio vazou, e peça a cada pessoa para
   conectar o Prisma de novo.)
3. **Parar envios para fora:** `EMAIL_ENVIO=desligado` e/ou `WHATSAPP_ENVIO=desligado` no
   `.env.production`, `$C up -d web worker`.
4. **WhatsApp:** a pessoa desconecta em Meu WhatsApp; ou, no servidor, pare a Evolution
   (`$C stop evolution`) — as mensagens novas ficam no celular e o `whatsapp-recuperar` relê
   as últimas 2 h ao voltar.
5. **Segredo exposto:** troque o segredo na origem (Entra, filtroAPP, Prisma, OpenAI, Evolution)
   e no `.env.production`; certificado do Graph: gere outro e remova o antigo no Entra.
   `GRAVACOES_CHAVE_MESTRA` **não pode ser só trocada** (as gravações cifradas dependem dela):
   fale com o responsável técnico antes.
6. **Não apague evidências:** não rode `RETENCAO=real` nem limpezas manuais durante o incidente.

## 4. Avaliar (o que aconteceu, com quem)

- Ações registradas (só inserção): `SQL "SELECT at, action, entity_type, entity_id FROM audit_log WHERE actor_person_id = '<id>' AND at > now() - interval '7 days' ORDER BY at"`.
  Inclui downloads (`arquivo.baixado`), abertura de e-mails da missão, perfis, compartilhamentos.
- E-mails enviados pelo Omni: `mail_outbox` (destinatários, anexos por nome); WhatsApp: `whatsapp_outbox`.
- Sessões e IPs: `sessions` (IP e navegador de cada login).
- Alertas de risco: `risk_alerts`; logs do web e do worker: `$C logs --since 24h web worker`.
- Liste **quais dados e de quem** (colaboradores, clientes, terceiros) e se há dado sensível
  (gravações de voz, documentos pessoais em anexos).

## 5. Comunicar

- Se o incidente puder trazer **risco ou dano relevante** aos titulares, o encarregado comunica
  a ANPD e os titulares no prazo da regulamentação vigente (hoje, Resolução CD/ANPD nº 15/2024:
  **3 dias úteis** a partir do conhecimento) — confirmar com o encarregado.
- Microsoft, OpenAI e o provedor da VPS: avisar quando o incidente envolver o serviço deles.
- Comunicação interna ao time: o que aconteceu, o que muda, o que cada um faz.

## 6. Recuperar

- Banco: restaurar do backup (`deploy/backup.sh`; **o backup automático do Omni ainda não está
  ativo na produção** — ver `PLANEJAMENTO.md`, situação de 16/11/2026).
- Gravações: ficam no SharePoint (site OmniAnexos), cifradas; sem o banco (chaves) e a
  `GRAVACOES_CHAVE_MESTRA` não podem ser ouvidas.
- Reativar o que foi desligado no passo 3, um item por vez, conferindo os logs.

## 7. Registrar e aprender (Administração → Incidentes)

Todo incidente vai para **Administração → Incidentes** (só quem tem o perfil admin; E21, migration
0086), aberto já na primeira hora e completado depois. O registro:

- **Aberto:** título, tipo, gravidade, quando começou, quando soubemos (conta o prazo do item 5) e o
  que aconteceu.
- **Resolvido:** com a hora em que voltou ao normal.
- **Encerrado:** só com a **causa** (por que aconteceu, não o sintoma) e **o que muda para não
  repetir** (correção, teste ou trava nova, com o PR nas referências). Se envolveu dado pessoal,
  também **que dados e de quem** (categorias, sem nomes) e **as comunicações** feitas, com datas, ou
  por que não foram necessárias. O banco recusa encerrar sem isso.
- Não se apaga: a Resolução CD/ANPD nº 15/2024 pede a guarda por pelo menos 5 anos. Quem criou e
  cada alteração (nomes dos campos, sem o texto) ficam no `audit_log` (`incidente.criado`,
  `incidente.alterado`).
- **Nada de dado pessoal no texto:** nada de nomes, e-mails, telefones ou trechos de mensagens.
  Descreva por categoria ("telefones de contatos do WhatsApp, mascarados").

Encerre em até 5 dias úteis depois de resolver. O encarregado de dados acompanha os que têm dado
pessoal.

### Quando abrir

Abra um registro para tudo da lista do item 1 e também para: indisponibilidade percebida por quem
usa, erro do sistema que afetou pessoas (não para todo erro da aba Erros), integração parada por
mais de um dia e dado que saiu para onde não devia, mesmo sem risco.
