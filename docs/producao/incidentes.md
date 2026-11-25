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

## 7. Registrar e aprender

Registre em até 5 dias úteis: data e hora do conhecimento, o que aconteceu, dados e titulares
afetados, medidas tomadas, comunicações feitas (com datas) e o que muda para não repetir.
Guarde o registro com o encarregado (a ANPD pode pedir).
