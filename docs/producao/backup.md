# Backup e restauração do Omni

Mesmo modelo do filtroAPP (`deploy/BACKUP.md` dele): cópia no Backblaze B2 de hora em hora, por dia e
por mês, e ensaio de restauração mensal. Bucket próprio: **`filtrovali-omni`** (privado).
Diferente do filtroAPP, **tudo roda como o usuário `omni`**, pelo cron dele, sem root.

| Agenda | Destino no B2 | O que leva | Guarda no B2 |
|---|---|---|---|
| De hora em hora (menos 01h e 02h) | `hourly-db/` | só o banco do Omni e o da Evolution | 7 dias |
| Todo dia às 02h20 | `daily/` | bancos, sessões do WhatsApp, gravações pendentes, segredos cifrados | 60 dias |
| Dia 1 às 01h20 | `monthly/` | igual ao diário | 365 dias |
| Dia 2 às 04h50 | ensaio de restauração do último diário | — | — |

Os minutos (:20 e :50) ficam fora dos horários do filtroAPP para os dois não rodarem juntos.

**Por que o usuário `omni`:** o Omni roda no Docker rootless dele (`/run/user/<uid>/docker.sock`, com
*linger* ligado), e ele já tem o `.env.production` e os certificados; root não acrescenta nada. Os
scripts usam esse socket mesmo no cron, que não carrega o `~/.profile`.

**Proteção dos backups:** a chave do B2 fica na conta `omni`, que já guarda os segredos da produção.
Por isso ela é criada **sem `deleteFiles`**: quem invadir a conta grava e lê, mas não apaga backups.
Quem apaga é a regra de expiração do próprio bucket, e o `b2 sync` do script nunca apaga.

Na VPS ficam os 5 últimos backups em `~/backups/omni-b2/` e o resultado em
`~/backups/omni-b2/status/backup-latest.json` e `restore-latest.json` (a cópia local antes de
publicar fica separada, em `~/backups/omni/`).

## O que cada backup guarda

| Arquivo | Para que serve |
|---|---|
| `omni.dump` | Banco do Omni (`pg_dump` formato custom). |
| `evolution.dump` | Banco da Evolution (mensagens, contatos e instâncias do WhatsApp). |
| `evolution-sessions.tar.gz` | Sessões pareadas. Sem ela, cada pessoa lê o QR code de novo. |
| `chamadas.tar.gz` | Gravações das ligações ainda não arquivadas no SharePoint. |
| `segredos.tar.gz.enc` | `deploy/.env.production` e `deploy/secrets/`, cifrados (AES-256, senha em arquivo). Sem a `GRAVACOES_CHAVE_MESTRA` as gravações no SharePoint não abrem, e sem os certificados não há login nem Graph. |
| `SHA256SUMS` | Conferência de integridade. |

Os arquivos do SharePoint (anexos, gravações arquivadas) já ficam fora da VPS, no Microsoft 365.

## Configurar (uma vez)

1. **Backblaze (painel ou CLI de quem administra a conta):** bucket privado `filtrovali-omni`, regras de
   expiração por prefixo (`hourly-db/` 7 dias, `daily/` 60 dias, `monthly/` 365 dias) e uma chave
   **só desse bucket e sem apagar**:

   ```bash
   b2 key create --bucket filtrovali-omni omni-backup listBuckets,listFiles,readFiles,writeFiles
   ```

   Não use a chave do filtroAPP nem a Master Key.

2. **CLI do B2 para o usuário `omni`** (sem sudo; o pipx já está na VPS): `pipx install b2`.
   Ela fica em `~/.local/bin/b2`, que os scripts já procuram.

3. **Credenciais e senha dos segredos**, como `omni`:

   ```bash
   install -d -m 700 ~/.config/omni-backup ~/logs
   editor ~/.config/omni-backup/b2.env
   # B2_APPLICATION_KEY_ID="<keyID>"
   # B2_APPLICATION_KEY="<applicationKey>"
   openssl rand -base64 48 > ~/.config/omni-backup/segredos.senha   # ou a senha que já está no cofre
   chmod 600 ~/.config/omni-backup/*
   ```

   **A senha de `segredos.senha` fica também no cofre de senhas da empresa.** Se a VPS for perdida, é
   ela que abre os segredos do backup. Se já existe uma no cofre (backups feitos antes), use a mesma.

4. **Primeiro backup e primeiro ensaio, à mão** (como `omni`):

   ```bash
   cd ~/apps/Omni
   B2_URI=b2://filtrovali-omni/daily deploy/backup-prod.sh
   deploy/restore-drill.sh
   cat ~/backups/omni-b2/status/backup-latest.json ~/backups/omni-b2/status/restore-latest.json
   ```

   No ensaio: `"status": "SUCCESS"`, `"secrets": "conferidos"` e `hoursSinceLastSync` baixo.

5. **Cron do `omni`** (`crontab -e`, como `omni`). Horários no relógio da VPS (UTC: o diário roda às
   23h20 de Brasília). Os minutos :20 e :50 não coincidem com o cron do filtroAPP.

   ```cron
   # De hora em hora (menos 01h e 02h): só os bancos -> hourly-db/ (7 dias)
   20 0,3-23 * * * B2_URI=b2://filtrovali-omni/hourly-db INCLUDE_VOLUMES=false INCLUDE_SECRETS=false /home/omni/apps/Omni/deploy/backup-prod.sh >> /home/omni/logs/backup-omni.log 2>&1
   # Todo dia 02h20: completo -> daily/ (60 dias)
   20 2 * * * B2_URI=b2://filtrovali-omni/daily BACKUP_LOCK_TIMEOUT_SECONDS=7200 /home/omni/apps/Omni/deploy/backup-prod.sh >> /home/omni/logs/backup-omni.log 2>&1
   # Dia 1, 01h20: completo -> monthly/ (365 dias)
   20 1 1 * * B2_URI=b2://filtrovali-omni/monthly BACKUP_LOCK_TIMEOUT_SECONDS=7200 /home/omni/apps/Omni/deploy/backup-prod.sh >> /home/omni/logs/backup-omni.log 2>&1
   # Dia 2, 04h50: ensaio de restauração do último diário
   50 4 2 * * /home/omni/apps/Omni/deploy/restore-drill.sh >> /home/omni/logs/restore-drill-omni.log 2>&1
   ```

   Sem aviso por e-mail ou Telegram na produção: uma falha fica no log e no JSON de status
   (`~/backups/omni-b2/status/`). O alerta que chega a uma pessoa é a entrega E09 (alerta de erro),
   que vai ler esses JSON. Os scripts ainda aceitam `TELEGRAM_TOKEN`/`TELEGRAM_CHAT_ID` se um dia
   voltarem.

   Os scripts rodam da pasta do repositório: uma publicação (`deploy/publicar.sh`) os atualiza junto
   com o código.

## Restaurar de verdade

1. Como `omni`, baixar o backup e conferir:
   `set -a; . ~/.config/omni-backup/b2.env; set +a; export B2_ACCOUNT_INFO=~/.config/omni-backup/b2_account_info`,
   `b2 sync b2://filtrovali-omni/daily/<AAAA-MM-DD-HHMMSS> ~/restaurar` e
   `cd ~/restaurar && sha256sum -c SHA256SUMS`.
2. Segredos (servidor novo):
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<senha> < segredos.tar.gz.enc | tar -xzf - -C ~/apps/Omni`.
3. Parar web e worker e restaurar o banco:

   ```bash
   omni() { docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production "$@"; }
   omni stop web worker
   omni exec -T postgres pg_restore -U postgres -d omni --clean --if-exists < ~/restaurar/omni.dump
   omni up -d --wait
   ```

4. Evolution e sessões (se for o caso), com a Evolution parada: `pg_restore` do `evolution.dump` no
   `evolution-postgres` e `tar -xzf evolution-sessions.tar.gz` dentro do volume `omni_evolution_sessions`.
5. Conferir `/api/saude` e registrar o incidente (`docs/producao/incidentes.md`).

## Conferido

- 25/11/2026, VPS de produção, como `omni` (sem B2 e sem segredos): `backup-prod.sh` gerou o backup
  em 7 s (omni.dump 12 MB, evolution.dump 50 MB, volumes) e o `restore-drill.sh` o restaurou num banco
  descartável no Docker do `omni` em 12 s: 78 migrations, 90 missões, sincronização de menos de 1 h,
  nenhuma tabela de dados sem RLS. A cópia de teste foi apagada em seguida.

- 25/11/2026, máquina de desenvolvimento: `restore-drill.sh` com um dump do banco de desenvolvimento
  e segredos cifrados de teste: 78 migrations, 30 pessoas, 90 missões restauradas em 11 s, segredos
  abertos e listados, nenhuma tabela de dados sem RLS.
