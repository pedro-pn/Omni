# Backup e restauração do Omni

Mesmo modelo do filtroAPP (`deploy/BACKUP.md` dele): cron do **root** na VPS, cópia no Backblaze B2 e
ensaio de restauração mensal. Bucket próprio: **`filtrovali-omni`** (privado).

| Agenda | Destino no B2 | O que leva | Guarda no B2 |
|---|---|---|---|
| De hora em hora (menos 01h e 02h) | `hourly-db/` | só o banco do Omni e o da Evolution | 7 dias |
| Todo dia às 02h20 | `daily/` | bancos, sessões do WhatsApp, gravações pendentes, segredos cifrados | 60 dias |
| Dia 1 às 01h20 | `monthly/` | igual ao diário | 365 dias |
| Dia 2 às 04h50 | ensaio de restauração do último diário | — | — |

Os minutos (:20 e :50) ficam fora dos horários do filtroAPP para os dois não rodarem juntos.

**Docker rootless:** o Omni roda no Docker do usuário `omni` (`/run/user/<uid>/docker.sock`, com
*linger* ligado), não no Docker do sistema, que é o do filtroAPP. O `backup-prod.sh` roda como root e
aponta para esse socket sozinho (`OMNI_DOCKER_USER=omni`). O ensaio de restauração usa o Docker do
sistema, porque o banco descartável não precisa do Omni.

Na VPS ficam os 5 últimos backups em `/root/backups/omni/` e o resultado em
`/root/backups/omni/status/backup-latest.json` e `restore-latest.json`.

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

## Configurar (uma vez, com `sudo`)

1. **Backblaze:** criar o bucket privado `filtrovali-omni` e uma Application Key **só desse bucket**
   (Read and Write). Não use a chave do filtroAPP nem a Master Key.
2. **Regras de expiração do bucket** (Lifecycle Rules, por prefixo): `hourly-db/` 7 dias,
   `daily/` 60 dias, `monthly/` 365 dias.
3. **Credenciais e senha dos segredos**, só para o root:

   ```bash
   sudo install -d -m 700 /root/.config/omni-backup /root/logs
   sudo editor /root/.config/omni-backup/b2.env
   # B2_APPLICATION_KEY_ID="<keyID>"
   # B2_APPLICATION_KEY="<applicationKey>"
   sudo sh -c 'openssl rand -base64 48 > /root/.config/omni-backup/segredos.senha'
   sudo chmod 600 /root/.config/omni-backup/*
   ```

   **Guarde a senha de `segredos.senha` no cofre de senhas da empresa.** Se a VPS for perdida, é ela
   que abre os segredos do backup.

4. **CLI do B2**: o root já tem a do filtroAPP (`/root/.local/bin/b2`). O Omni usa a própria chave
   (pelas variáveis do `b2.env`) e um arquivo de conta separado
   (`B2_ACCOUNT_INFO=/root/.config/omni-backup/b2_account_info`), sem mexer na autorização do filtroAPP.

5. **Primeiro backup e primeiro ensaio, à mão:**

   ```bash
   cd /home/omni/apps/Omni
   sudo B2_URI=b2://filtrovali-omni/daily deploy/backup-prod.sh
   sudo deploy/restore-drill.sh
   sudo cat /root/backups/omni/status/restore-latest.json   # status SUCCESS e o tempo da restauração
   ```

6. **Cron do root** (`sudo crontab -e`), com o `TELEGRAM_TOKEN`/`TELEGRAM_CHAT_ID` do filtroAPP para
   receber as falhas:

   ```cron
   TELEGRAM_TOKEN=<o mesmo do filtroAPP>
   TELEGRAM_CHAT_ID=<o mesmo do filtroAPP>
   20 0,3-23 * * * B2_URI=b2://filtrovali-omni/hourly-db INCLUDE_VOLUMES=false INCLUDE_SECRETS=false /home/omni/apps/Omni/deploy/backup-prod.sh >> /root/logs/backup-omni.log 2>&1
   20 2 * * * B2_URI=b2://filtrovali-omni/daily BACKUP_LOCK_TIMEOUT_SECONDS=7200 /home/omni/apps/Omni/deploy/backup-prod.sh >> /root/logs/backup-omni.log 2>&1
   20 1 1 * * B2_URI=b2://filtrovali-omni/monthly BACKUP_LOCK_TIMEOUT_SECONDS=7200 /home/omni/apps/Omni/deploy/backup-prod.sh >> /root/logs/backup-omni.log 2>&1
   50 4 2 * * /home/omni/apps/Omni/deploy/restore-drill.sh >> /root/logs/restore-drill-omni.log 2>&1
   ```

   O cron do root roda o script da pasta do repositório: uma publicação (`deploy/publicar.sh`) muda o
   script junto com o código, como no filtroAPP.

## Restaurar de verdade

1. Baixar o backup: `sudo -E b2 sync b2://filtrovali-omni/daily/<AAAA-MM-DD-HHMMSS> /root/restaurar`
   (com as variáveis do `b2.env` carregadas) e conferir: `cd /root/restaurar && sha256sum -c SHA256SUMS`.
2. Segredos (servidor novo):
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<senha> < segredos.tar.gz.enc | tar -xzf - -C /home/omni/apps/Omni`.
3. Parar web e worker e restaurar o banco:

   ```bash
   omni() { docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production "$@"; }
   omni stop web worker
   omni exec -T postgres pg_restore -U postgres -d omni --clean --if-exists < /root/restaurar/omni.dump
   omni up -d --wait
   ```

4. Evolution e sessões (se for o caso), com a Evolution parada: `pg_restore` do `evolution.dump` no
   `evolution-postgres` e `tar -xzf evolution-sessions.tar.gz` dentro do volume `omni_evolution_sessions`.
5. Conferir `/api/saude` e registrar o incidente (`docs/producao/incidentes.md`).

## Conferido

- 25/11/2026, máquina de desenvolvimento: `restore-drill.sh` com um dump do banco de desenvolvimento
  e segredos cifrados de teste: 78 migrations, 30 pessoas, 90 missões restauradas em 11 s, segredos
  abertos e listados, nenhuma tabela de dados sem RLS.
