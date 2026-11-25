# Backup e restauração do Omni

Mesmo modelo do filtroAPP (`deploy/BACKUP.md` dele, conferido em produção em 25/11/2026): cópias
locais completas ao longo do dia, um diário e um mensal no Backblaze B2 e o ensaio de restauração
mensal. Bucket próprio: **`filtrovali-omni`** (privado). Diferente do filtroAPP, **tudo roda como o
usuário `omni`**, pelo cron dele, sem root.

| Rotina | Horário UTC | Brasília (UTC−3) | Destino |
|---|---|---|---|
| Cópia local completa | 00h20, 03h20, 08h20, 13h20, 18h20 e 23h20 | 21h20 (dia anterior), 00h20, 05h20, 10h20, 15h20 e 20h20 | `~/backups/omni-b2/<data-hora>` (guarda 2) |
| Diário completo | 02h20 | 23h20 (dia anterior) | `b2://filtrovali-omni/daily/<data-hora>` |
| Mensal completo | Dia 1, 01h20 | Último dia do mês anterior, 22h20 | `b2://filtrovali-omni/monthly/<data-hora>` |
| Ensaio de restauração | Dia 2, 04h50 | Dia 2, 01h50 | PostgreSQL descartável; status local |

São os horários do filtroAPP deslocados 20 minutos (o ensaio, 20 minutos depois do dele), para os
dois não disputarem CPU e disco na mesma VPS. Como no filtroAPP, `0,3-23/5` também roda às 23h e às
00h (uma hora de intervalo nessa virada). Não há backup de hora em hora.

**Retenção no B2** (Lifecycle Rules do bucket, iguais às do filtroAPP):

| Prefixo | Ocultar após o envio | Apagar após ocultar |
|---|---|---|
| `daily/` | 7 dias | 1 dia |
| `monthly/` | 60 dias | 1 dia |

**Retenção na VPS** (mesma regra do script do filtroAPP): a cópia local guarda as 2 mais novas
(`LOCAL_BACKUP_KEEP=2`); depois de um diário ou mensal enviado com sucesso, fica só aquela execução,
e as cópias locais voltam a acumular até 2. Sem envio bem-sucedido, nada é apagado. A cópia de antes
de publicar (`deploy/backup.sh`) fica separada, em `~/backups/omni/`.

**Por que o usuário `omni`:** o Omni roda no Docker rootless dele (`/run/user/<uid>/docker.sock`, com
*linger* ligado), e ele já tem o `.env.production` e os certificados; root não acrescenta nada. Os
scripts usam esse socket mesmo no cron, que não carrega o `~/.profile`.

**Proteção dos backups:** a chave do B2 fica na conta `omni`, que já guarda os segredos da produção.
Por isso ela é criada **sem `deleteFiles`**: quem invadir a conta grava e lê, mas não apaga backups.
Quem apaga é a regra de expiração do próprio bucket, e o `b2 sync` do script nunca apaga.

O resultado de cada execução fica em `~/backups/omni-b2/status/backup-latest.json` e o do ensaio em
`restore-latest.json`.

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

1. **Backblaze (painel ou CLI de quem administra a conta):** bucket privado `filtrovali-omni`, as
   regras de expiração da tabela acima (`daily/` oculta em 7 dias, `monthly/` em 60; apagar 1 dia
   depois de ocultar) e uma chave **só desse bucket e sem apagar**:

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

5. **Cron do `omni`** (`crontab -e`, como `omni`). A VPS está em `Etc/UTC` e o crontab não define
   `TZ`: os horários são UTC. Antes de instalar, confira `crontab -l` para não duplicar linhas.

   ```cron
   # Cópia local completa: 00h20, 03h20, 08h20, 13h20, 18h20 e 23h20 UTC; sem envio; guarda 2.
   20 0,3-23/5 * * * BACKUP_LOCK_TIMEOUT_SECONDS=0 LOCAL_BACKUP_KEEP=2 /home/omni/apps/Omni/deploy/backup-prod.sh >> /home/omni/logs/backup-omni.log 2>&1

   # Diário completo às 02h20 UTC; espera até 2h pelo lock.
   20 2 * * * B2_URI=b2://filtrovali-omni/daily BACKUP_LOCK_TIMEOUT_SECONDS=7200 /home/omni/apps/Omni/deploy/backup-prod.sh >> /home/omni/logs/backup-omni.log 2>&1

   # Mensal completo no dia 1 às 01h20 UTC; espera até 2h pelo lock.
   20 1 1 * * B2_URI=b2://filtrovali-omni/monthly BACKUP_LOCK_TIMEOUT_SECONDS=7200 /home/omni/apps/Omni/deploy/backup-prod.sh >> /home/omni/logs/backup-omni.log 2>&1

   # Ensaio de restauração no dia 2 às 04h50 UTC, a partir do último diário.
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
