# Guia de produção do Omni: tudo o que configurar, na ordem

> Escrito em 11/11/2026 (migrations até a 0048; chamadas do WhatsApp incluídas no mesmo dia, §13). É o ponto de entrada. Os detalhes de cada passo ficam nos documentos citados:
> comandos do deploy em `deploy.md`, o corte do Foco em `entrada-em-producao.md` §2, LGPD em `lgpd-ropa-dpa.md`.
> Modelo das variáveis: `deploy/production.env.example`. Atualize este guia sempre que surgir um item novo.

**Regra de ouro:** a produção sobe com tudo o que **sai** do Omni em ensaio ou desligado (e-mail, WhatsApp, escrita no filtroAPP, IA). Cada modo real só é ligado depois do passo 9 (comunicado ao time e ROPA).

## 0. O que fica fora desta entrada

- **Migração dos dados do Foco:** depois da produção no ar (passo 11).
- **Registro em lote no Prisma:** depois.

## 1. VPS, DNS e Caddy

| O quê | Onde | Detalhe |
|---|---|---|
| Usuário `omni`, Docker rootless, repositório (chave de implantação só de leitura) | VPS | `deploy.md` §3.1 e §3.3 |
| DNS `omni.filtrovali.com.br` → IP da VPS | DNS da Filtrovali | Registro A |
| Bloco `omni.filtrovali.com.br` no Caddy compartilhado | `filtroAPP-main/deploy/infra-proxy` | Copiar de `deploy/caddy/omni.caddy`; porta **8084** |
| Rota do áudio das chamadas | mesmo bloco do Caddy | `handle /omni/audio` → porta **8086** (já no bloco de `omni.caddy`; §13) |
| Firewall (ufw) para o Caddy | VPS, como root | Regra da rede do proxy para **8084** e, com as chamadas, **8086**: `sudo ufw allow in on br-c2f4434f4e13 from 172.20.0.0/16 to 172.17.0.1 port 8084 proto tcp` (comandos e conferência em `deploy.md` §4.1) |
| RAM | VPS | ~2,5 GB (web, worker, Postgres) + ~1,5 GB com o WhatsApp + até 1 GB com as chamadas |
| Firewall | VPS | Saída liberada para a internet (o áudio das ligações vai direto aos servidores do WhatsApp, inclusive UDP) |

## 2. Microsoft (Entra, Exchange, Teams, SharePoint)

### 2.1 Login: app "Omni" (`entra-registro.md`)
- [ ] Acrescentar a URI de redirecionamento `https://omni.filtrovali.com.br/auth/callback`.
- [ ] `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` e **uma** credencial (a validação recusa as duas juntas):
  - **certificado (recomendado):** gerar na VPS em `deploy/secrets/` (`entra-registro.md` §3), carregar só o `.crt` no app "Omni" → `ENTRA_PRIVATE_KEY_PATH=/run/secrets/omni/omni-entra.key` e `ENTRA_CERT_SHA256_THUMBPRINT` (impressão SHA-256, 64 caracteres hexadecimais), com `ENTRA_CLIENT_SECRET` vazio;
  - **ou** segredo do cliente novo → `ENTRA_CLIENT_SECRET`, com as duas do certificado vazias.
- [ ] Apagar o segredo de desenvolvimento (`omni-dev`) do app, se existir.
- [ ] **Quem pode entrar:** em **Aplicativos empresariais → Omni → Propriedades**, **Atribuição necessária = Sim**; em **Usuários e grupos**, adicionar as pessoas ou os grupos liberados. O Omni lê essa lista de hora em hora (job `entra-pessoas`) e já coloca cada pessoa em Administração → Pessoas, para você definir perfis e funções antes do primeiro acesso. Quem sai do app (ou tem a conta desativada) é desativado no Omni e perde a sessão; voltando, é reativado. Convidados ficam de fora. Precisa do passo 2.2 (permissões) e de `ENTRA_CLIENT_ID` também no worker (o compose já repassa).

### 2.2 Integrações: app "Omni – Integrações" (`m365-registro.md`)
É o mesmo app do tenant, já configurado. Na produção:
- [ ] Copiar o certificado (`omni-graph.key`, válido até **02/11/2028**) para `deploy/secrets/` na VPS. Nunca pelo chat ou pelo Git.
- [ ] **Permissões (Docker rootless):** `chmod 711 deploy/secrets` e `chmod 644 deploy/secrets/*.key`. Com a pasta em 700, o contêiner não lê as chaves: o login Microsoft dá erro 500 e o Graph não funciona (`deploy.md` §3.3, com o comando para conferir).
- [ ] `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CERT_SHA256_THUMBPRINT` e `GRAPH_PRIVATE_KEY_PATH=/run/secrets/omni/omni-graph.key`: caminho **de dentro do contêiner**, não `./secrets/…`.
- [ ] **Caixas:** o e-mail de cada pessoa é cadastrado no Omni **sozinho no primeiro login** (migration 0058), mas o Exchange só libera ao app as caixas do grupo `Omni - Caixas` (membro direto). **Recomendado:** use o próprio `Omni - Caixas` (grupo de segurança habilitado para e-mail) como o grupo atribuído ao app "Omni" em Usuários e grupos (passo 2.1): uma só inclusão libera o login, a lista de Pessoas e o e-mail. Ponha também a caixa remetente dos avisos (ex.: `omni@filtrovali.com.br`). Fora do grupo, a caixa aparece em Administração → Caixas com o aviso "Sem acesso a esta caixa". Só depois do comunicado (passo 9).
- [ ] **Teams:** acrescentar à política `Omni-Reunioes` os usuários cujas reuniões o Omni lê (hoje só o piloto). Transcrições já liberadas no tenant (10/11).
- [ ] **Permissões novas (lista de Pessoas):** em **Registros de aplicativo → Omni – Integrações → Permissões de API**, adicionar as permissões de **aplicativo** `Application.Read.All` e `GroupMember.Read.All` e **conceder consentimento do administrador** (`User.Read.All` já está). Sem elas, o worker registra `entra-pessoas … 403 Authorization_RequestDenied` e não muda ninguém (`m365-registro.md`).
- [ ] **SharePoint:** concessão `Sites.Selected` já feita (site Arquivos Filtrovali, lista "6 - DEPARTAMENTO COMERCIAL / A Propostas"). Nada a fazer, salvo se mudar o site.
- [ ] Mais tarde: lembrete para renovar o certificado antes de 02/11/2028.

## 3. filtroAPP (`docs/integracoes/filtroapp-token.md`)
- [ ] Token **"Omni – produção"** (`writeMode` `LIVE`), restrito ao IP da VPS, com **todos** os escopos da lista oficial (inclusive os da spec 038: PDF, manutenção e `contato_corporativo`).
- [ ] `FILTROAPP_API_TOKEN` (worker e web usam o mesmo). `FILTROAPP_ESCRITA=desligada` na subida; `real` só depois de conferir os escopos de escrita (`qualidade.registros.create` e `logistica.descargas.create`). Só valem `desligada`, `simulada` ou `real`: qualquer outro valor (ex.: `ligada`) impede o worker de subir.
- [ ] Spec 038 (PDF dos relatórios) publicada no filtroAPP: feito em 11/11/2026.

## 4. Prisma CRM (`infra/omni/README.md` do Prisma)
- [ ] Ativar a produção da API do Omni no Prisma (pronta e desligada): o desenvolvedor do Prisma cadastra o hash, roda o `enable-production.sql` e entrega o segredo por canal privado.
- [ ] `PRISMA_OMNI_ENVIRONMENT=production` e `PRISMA_OMNI_READER_TOKEN` de produção (worker e web).
- [ ] Depois de subir: cada pessoa conecta de novo a conta do Prisma pelo menu do perfil (as conexões do sandbox não valem na produção).
- [ ] O cliente PKCE de produção do Prisma deve aceitar o retorno `https://omni.filtrovali.com.br/integracoes/prisma/retorno`.

## 5. OpenAI (`docs/adr/0005-llm-openai.md`)
- [ ] Chave da organização com **retenção zero** → `OPENAI_API_KEY`. Modelos: `OPENAI_MODEL`, `OPENAI_TRANSCRICAO_MODEL`.
- [ ] Todas as `IA_*` em `desligada` na subida; ligar uma a uma depois do passo 9: `IA_LEITURA_RDO`, `IA_ALERTAS`, `IA_RESUMO_REUNIAO`, `IA_ASSINATURAS`, `IA_RESUMO_CHAMADA` (só resume quando o dono da gravação pede).

## 6. Segredos gerados na VPS (um valor novo por linha, `openssl rand -hex 32`)
- [ ] `POSTGRES_PASSWORD`, `OMNI_OWNER_PASSWORD`, `OMNI_APP_PASSWORD`, `OMNI_WORKER_PASSWORD`, `AUTH_SECRET`.
- [ ] VAPID de produção: `npx web-push generate-vapid-keys` → `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`. Trocar depois invalida as inscrições.
- [ ] WhatsApp: `WHATSAPP_EVOLUTION_KEY`, `WHATSAPP_WEBHOOK_SECRET`, `EVOLUTION_POSTGRES_PASSWORD`.
- [ ] Chamadas: `CHAMADAS_SERVICO_KEY` (web, worker e serviço de voz) e `CHAMADA_PONTE_TOKEN` (serviço de voz e Evolution) — duas chaves diferentes (§13.2).
- [ ] Gravações: `GRAVACOES_CHAVE_MESTRA` (web e worker). **Guarde uma cópia fora da VPS**: sem ela, as gravações cifradas no SharePoint não podem mais ser ouvidas (§13.7).
- [ ] `APPLE_CALENDAR_SIGNING_KEY`: **não gerar.** Usar a do Foco (`APPLE_CALENDAR_SIGNING_KEY` dele, ou a `SUPABASE_SERVICE_ROLE_KEY` se ele não tinha a própria), para os links de agenda já assinados continuarem valendo.

## 7. Subir
- [ ] `deploy/.env.production` a partir de `deploy/production.env.example`, preenchido na VPS (nunca no Git).
- [ ] `docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production --profile whatsapp --profile chamadas up -d --build` (as migrations rodam sozinhas no serviço `migrate`). Sem as chamadas, tire `--profile chamadas` e deixe `CHAMADAS_HABILITADAS=off` e `CHAMADA_PONTE` vazio.
- [ ] Conferir as chamadas (§13.4).
- [ ] Primeiro administrador: `packages/db/src/cli/primeiro-admin.ts` (`deploy.md` §4). O resto pela Administração.
- [ ] Conferir (`deploy.md` §5): login Microsoft, worker rodando os jobs (logs), sincronização do filtroAPP, missões na tela.
  - `docker ps`: nenhum contêiner em `Restarting`. Se o worker ou o web reiniciar, `logs --tail 20 <serviço>` mostra a variável inválida (`Variáveis de ambiente inválidas no worker: …`).
  - Chaves legíveis dentro do contêiner (comando em `deploy.md` §3.3).
- [ ] Backup diário: `deploy/backup.sh omni deploy/.env.production` no crontab (`deploy.md` §7), guardando fora da VPS também.

## 8. Configurar dentro do Omni (Administração)
- [ ] **Perfis** de cada pessoa (diretoria, gerentes, administração, comercial…). Com o passo 2.1 (Usuários e grupos do app "Omni"), as pessoas já aparecem aqui antes do primeiro acesso (até 1 h depois de liberadas no Entra).
- [ ] **Funções:** quem ocupa Qualidade, Medição, Faturamento, Gerente comercial, Coordenação de mobilização, Líder de projetos… (sem as pessoas `@omni.invalid` do desenvolvimento).
- [ ] **Feriados** municipais e da empresa do ano.
- [ ] **Caixas de e-mail:** entram sozinhas no primeiro login de cada pessoa; em Administração → Caixas (só administradores) ficam as caixas de setor e o aviso das que estão fora do grupo do Exchange.
- [ ] **WhatsApp:** cada pessoa pareia o próprio número em Conversas (a Administração não cadastra números). **Antes, desconectar o número do Omni de desenvolvimento**: cada número fica conectado a um sistema só. Inventário: número, responsável pelo aparelho (só ele vê as conversas daquele número; nem a Administração nem a diretoria), grupos cujo histórico importar.
- [ ] Cada pessoa: **Notificações e app** (instalar, ativar no aparelho, notificação de teste) e conectar o Prisma.
- [ ] **Chamadas:** responsável de cada número, permissão de gravar e conexão de cada linha (§13.5).

## 9. LGPD antes de ligar o que é real (`lgpd-ropa-dpa.md`)
- [ ] ROPA e RIPD revisados com o encarregado, incluindo a **retenção das gravações das ligações**: **5 anos** (decisão de 11/11/2026; padrão do modo `producao`, `CHAMADA_RETENCAO_HORAS` vazio), mais até 14 dias nos backups depois de excluída.
- [ ] **Termo de uso e privacidade** (página `/termos`): o texto está em `packages/core/src/termos.ts` e deve ser validado pelo encarregado antes de abrir para o time. Cada pessoa aceita no primeiro acesso; sem o aceite, o Omni não abre (nem dados, nem downloads, nem eventos). O aceite fica em `terms_acceptances` (versão, SHA-256 do texto, data, IP e navegador) e aparece em Administração → Pessoas. Mudou o texto? Troque `TERMOS.versao`: todos aceitam de novo.
- [ ] Política interna escrita e **comunicada** ao time (e-mails visíveis à gestão, IA, WhatsApp, fotos e nomes das conversas).
- [ ] Aviso de privacidade externo atualizado (site).

## 10. Ligar os modos reais (um de cada vez, conferindo)
- [ ] `EMAIL_ENVIO=real` + `EMAIL_AVISOS_REMETENTE`. Primeiro envio para um endereço interno; conferir em `mail_outbox` / `notification_emails` (status `enviado`).
- [ ] `WHATSAPP_ENVIO=real`. Primeira resposta para um número interno.
- [ ] `FILTROAPP_ESCRITA=real`.
- [ ] `IA_*` ligadas, uma de cada vez.
- [ ] Testes de campo: notificações em um Android e em um iPhone (Omni instalado na Tela de Início); um resumo de reunião do Teams real (`teams-transcricoes.md`, passo 3).
- [ ] **Chamadas:** o roteiro de teste com número real (§13.6) antes de liberar para o time.

## 11. Corte do Foco (por último): `entrada-em-producao.md` §2
Migrar tarefas (mesmo id), chaves de API e links de agenda; baixar o TTL do DNS de `foco.filtrovali.com.br`; Caddy com proxy para `/api/v1/*` e `/api/prisma-authorization/*` e 308 para o resto; servir o logo dos e-mails antigos; avisar o time.

## 12. Depois que a produção estiver no ar
- [ ] No **staging**: desligar WhatsApp e `IA_*` ou parar (`omni-stg stop`).
- [ ] No **desenvolvimento**: o worker local lê a produção do filtroAPP e as caixas pelo Graph. Deixar `IA_*` desligadas ali, para não haver duas IAs lendo os mesmos RDOs.

## 13. Chamadas do WhatsApp: tudo num lugar

Cada pessoa liga e atende pelo Omni usando o **próprio** número já conectado (Conversas / Meu WhatsApp), com gravação opcional por permissão e aviso. Detalhes do produto e da arquitetura: `docs/integracoes/chamadas-omni.md`.

> **Situação em 11/11/2026:** pronto no compose de produção e ensaiado localmente sem número pareado (portas, chaves, rede interna, ponte e áudio do navegador conferidos). **Ainda não houve ligação real com esta configuração**: faça o roteiro do §13.6, de preferência no staging, antes de liberar para o time.

### 13.1 Como fica na VPS

```
navegador ──wss /omni/audio──► Caddy ──► 172.17.0.1:8086 ──► voz:8099  (só /omni/audio e /health)
web / worker ──http + chave──────────────────────────────► voz:8098  (API interna, sem porta publicada)
voz ──ws + token──────────────────────────────────────────► evolution:8097  (ponte, sem porta publicada)
voz ──http + chave───────────────────────────────────────► web:3000/api/chamadas/eventos
voz ◄──áudio (UDP/TCP)──► servidores do WhatsApp (internet)
```

- Serviço novo **`voz`** (perfil `chamadas`, junto do `whatsapp`), imagem `experiments/whatsapp-chamada`, gravações no volume `chamadas_data`.
- A **Evolution** da produção passa a usar `deploy/evolution/Dockerfile.chamadas` (mesmo patch de presença + a ponte). Sem `CHAMADA_PONTE`, a ponte fica desligada e a Evolution funciona como antes.
- Os outros apps não mudam. O Caddy ganha só a rota `/omni/audio`.

### 13.2 Variáveis (`deploy/.env.production`)

| Variável | Produção | Staging | Para quê |
|---|---|---|---|
| `CHAMADAS_HABILITADAS` | `on` | `on` | liga as chamadas no web |
| `CHAMADAS_SERVICO_URL` | `http://voz:8098` | `http://voz:8098` | web e worker falam com o serviço de voz |
| `CHAMADAS_SERVICO_KEY` | gerar | gerar (outra) | chave entre web/worker e o serviço de voz |
| `CHAMADA_PONTE_TOKEN` | gerar (diferente da anterior) | gerar | chave entre o serviço de voz e a ponte na Evolution |
| `CHAMADA_MODO` | `producao` | `teste` | `producao`: qualquer contato; `teste`: só a lista |
| `CHAMADA_PONTE` | `producao` | `omni` | modo da ponte na Evolution (vazio = desligada) |
| `CHAMADA_NUMEROS_TESTE` | **vazio** (a produção recusa a lista) | números da equipe, DDI+DDD+número, separados por vírgula | só no staging |
| `OMNI_AUDIO_PORT` | `8086` | `8088` (a 8087 é de outro serviço da VPS) | porta do áudio que o Caddy encaminha |
| `GRAVACOES_CHAVE_MESTRA` | gerar (`openssl rand -hex 32`; **cópia fora da VPS**) | gerar (outra) | abre a chave de cada gravação cifrada no SharePoint (web e worker) |
| `CHAMADA_LIMITE_SEGUNDOS` | vazio = 3600 (máx. 14400) | vazio = 600 | duração máxima de uma ligação |
| `CHAMADA_RETENCAO_HORAS` | vazio = **43800, 5 anos** (decisão de 11/11/2026; máx. 87600) | vazio = 24 | por quanto tempo a gravação fica |
| `IA_RESUMO_CHAMADA` | `desligada` → `ligada` (passo 10) | à escolha | "Resumir com IA" (só quando o dono pede) |
| `CHAMADA_DIAGNOSTICO` | não definir (`0`) | `1` só para investigar | registra por onde a ligação passou, sem áudio e com números mascarados |

As duas chaves: `openssl rand -hex 32`, cada uma diferente e nunca as do desenvolvimento. O `APP_ORIGIN` (`https://omni.filtrovali.com.br`) também é a origem que o serviço de voz aceita para o áudio. Sem https, ele não sobe no modo `producao`.

### 13.3 Antes de subir
- [ ] Caddy: bloco novo de `deploy/caddy/omni.caddy` (com `handle /omni/audio`) no Caddyfile do proxy compartilhado, e recarregar (`deploy.md` §4.1).
- [ ] Firewall da VPS: saída para a internet liberada, inclusive UDP. O áudio vai direto do serviço de voz aos servidores do WhatsApp; nenhuma porta de entrada nova é necessária.
- [ ] RAM: até 1 GB a mais para o serviço de voz.
- [ ] Docker Compose 2.17 ou mais novo na VPS (a imagem da Evolution usa `additional_contexts`): `docker compose version`.

### 13.4 Subir e conferir
```bash
docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production \
  --profile whatsapp --profile chamadas up -d --build --wait
docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production \
  --profile whatsapp --profile chamadas logs voz | tail -3    # "Chamadas POC (producao)"
docker ps --format '{{.Names}}\t{{.Ports}}'                  # publicadas só 172.17.0.1:8084 (web) e 172.17.0.1:8086 (áudio)
curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1:8086/health             # 200
curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1:8086/internal/control   # 404: a API interna não sai por essa porta
```
- Se o `voz` não subir, o log diz qual variável está errada. As mais comuns: lista de teste preenchida na produção, `APP_ORIGIN` sem https, chave com menos de 32 caracteres.
- Se a Evolution não subir com `CHAMADA_PONTE` preenchido, falta `CHAMADA_PONTE_TOKEN` (mínimo 32).
- Sem as chamadas: suba sem `--profile chamadas`, com `CHAMADAS_HABILITADAS=off` e `CHAMADA_PONTE` vazio.

### 13.5 Configurar no Omni
- [ ] **Antes:** desconectar cada número do Omni de desenvolvimento e do painel antigo da prova de conceito. Cada número fica pareado num sistema só; o WhatsApp de um aparelho antigo da mesma conta pode recusar as ligações (WhatsApp → Aparelhos conectados).
- [ ] Cada pessoa conecta o próprio WhatsApp em **Conversas** (o QR code aparece sozinho para quem ainda não tem número) e cuida dele em **Meu WhatsApp** (menu do perfil). Só ela controla as ligações e as conversas da linha. A Administração marca, em **Administração → Pessoas**, quem **pode gravar as próprias ligações**.
- [ ] Cada responsável: **Chamadas → Conectar meu WhatsApp** (usa o pareamento existente, sem novo QR), liberar o microfone e deixar ligado **Receber ligações no Omni**. O ponto verde em Chamadas indica a linha pronta.
- [ ] Avisar o time: gravar só marcando **Gravar esta ligação** e confirmando que os participantes foram avisados; gravações são privadas, compartilhadas uma a uma e revogáveis; administração e diretoria não ouvem sem compartilhamento.

### 13.6 Roteiro de teste com número real (staging com `CHAMADA_MODO=teste`, depois a produção)
- [ ] Receber uma ligação de um **iPhone** e de um **Android**: toca em qualquer tela do Omni, atender, áudio nos dois sentidos, desligar pelos dois lados.
- [ ] Fazer uma ligação pelo Omni para um contato (na produção, um contato fora de qualquer lista).
- [ ] **Duas pessoas**, cada uma com a sua linha: uma não vê a linha, as ligações nem as gravações da outra.
- [ ] Gravar com o aviso, ouvir a gravação, compartilhar com outra pessoa, conferir que ela ouve, revogar e conferir que deixou de ouvir.
- [ ] Um administrador sem compartilhamento **não** ouve a gravação.
- [ ] Ligação perdida vira aviso no sino.
- [ ] Com `IA_RESUMO_CHAMADA=ligada`: "Resumir com IA" numa gravação, pendência vira tarefa, "Registrar no Prisma".
- [ ] Excluir uma gravação: some do Omni e do serviço de voz (o resumo junto).
- [ ] Trocar de tela durante a ligação: a ligação continua e a barra volta aos controles.

### 13.7 Operação
- **Onde ficam (migrations 0052–0053, job `chamadas-arquivar`, a cada 2 min):** terminada a ligação, o worker comprime a gravação em **M4A** (AAC 48 kbps, os dois lados separados; ≈ 22 MB por hora), **cifra** com uma chave só daquela gravação (AES-256-GCM em blocos de 64 KiB) e envia ao SharePoint, site **OmniAnexos**, em `Gravacoes/AAAA/MM/<id da ligação>.m4a.cifrado` (staging: `Gravacoes-staging`). Confere o tamanho e só então apaga o WAV do serviço de voz: a VPS guarda a gravação só por alguns minutos. **No SharePoint nunca vai áudio aberto**: nem os administradores do Microsoft 365 conseguem ouvir. Ouvir continua pelo Omni: o servidor abre a chave da gravação e decifra só o trecho que o player pede (avançar e voltar funcionam). Precisa de `GRAPH_ANEXOS_DRIVE_ID` (já no modelo), `GRAVACOES_CHAVE_MESTRA`, do Graph configurado e do `ffmpeg` (já na imagem do worker); sem um deles, o worker avisa no log e as gravações ficam no serviço de voz.
- **Chave mestra (`GRAVACOES_CHAVE_MESTRA`, web e worker):** `openssl rand -hex 32`, uma só por ambiente. Ela protege a chave de cada gravação, guardada no banco. **Guarde uma cópia fora da VPS (cofre de senhas da TI)**: se ela se perder, nenhuma gravação pode mais ser ouvida. Não troque o valor depois que houver gravações (a troca exigiria regravar as chaves; a coluna `chave_versao` já está pronta para isso).
- **Retenção:** 5 anos. **Excluir apaga a chave da gravação na hora** (gatilho no banco): a gravação fica ilegível mesmo se sobrar alguma cópia no SharePoint, na lixeira ou numa política de retenção do Microsoft 365. Além disso, o worker (e o web, na hora da exclusão) apaga o arquivo **de vez** no SharePoint. Vencida, o worker apaga o arquivo e a chave. A linha da ligação continua no histórico do Omni. Os backups do banco guardam a chave por até 14 dias depois da exclusão.
- **Políticas de retenção do Microsoft 365:** com a cifra, uma cópia guardada pela Purview é ilegível sem a chave do Omni; mesmo assim, registre no ROPA se houver alguma aplicada ao site.
- **Espaço:** ≈ 22 MB por hora gravada no SharePoint (20 h por mês ≈ 26 GB em 5 anos; o tenant tem 1 TB + 10 GB por licença). Na VPS, só o que ainda não foi enviado.
- **Backup:** `deploy/backup.sh` copia o volume do serviço de voz (só gravações ainda não enviadas). As do SharePoint ficam na redundância e no controle de versão da Microsoft.
- **Investigar uma ligação que não tocou:** `CHAMADA_DIAGNOSTICO=1`, recriar o `voz`, reproduzir, ler `logs voz` e voltar para `0`.
- **Atualizar:** o mesmo `up -d --build` com os dois perfis. Recriar a Evolution derruba as linhas por alguns segundos: elas reconectam sozinhas enquanto o Omni estiver aberto.

## Variáveis: referência rápida

| Variável | Produção | De onde vem |
|---|---|---|
| `OMNI_AMBIENTE` / `APP_ORIGIN` / `OMNI_WEB_PORT` | `producao` / `https://omni.filtrovali.com.br` / `8084` | fixo |
| `POSTGRES_PASSWORD`, `OMNI_*_PASSWORD`, `AUTH_SECRET` | gerar | passo 6 |
| `ENTRA_*` | app "Omni" (`ENTRA_CLIENT_ID` também no worker: lista de Pessoas) | passo 2.1 |
| `GRAPH_*`, `OMNI_SECRETS_DIR` | app "Omni – Integrações" + certificado | passo 2.2 |
| `EMAIL_ENVIO` / `EMAIL_AVISOS_REMETENTE` | `ensaio` → `real` / caixa remetente | passos 2.2 e 10 |
| `FILTROAPP_API_URL` / `FILTROAPP_API_TOKEN` / `FILTROAPP_ESCRITA` | padrão / token de produção / `desligada` → `real` | passo 3 |
| `PRISMA_OMNI_ENVIRONMENT` / `PRISMA_OMNI_READER_TOKEN` | `production` / reader de produção | passo 4 |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TRANSCRICAO_MODEL` | chave com retenção zero | passo 5 |
| `IA_LEITURA_RDO`, `IA_ALERTAS`, `IA_RESUMO_REUNIAO`, `IA_ASSINATURAS`, `IA_RESUMO_CHAMADA` | `desligada` → `ligada` | passos 5 e 10 |
| `CHAMADAS_*`, `CHAMADA_*`, `OMNI_AUDIO_PORT` | ver a tabela das chamadas | §13.2 |
| `WEB_PUSH_*` | VAPID de produção | passo 6 |
| `WHATSAPP_*`, `EVOLUTION_POSTGRES_PASSWORD` | Evolution própria; `WHATSAPP_ENVIO` `ensaio` → `real` | passos 6, 8 e 10 |
| `APPLE_CALENDAR_SIGNING_KEY` | a mesma do Foco | passo 6 |
| `AUTH_DEV_LOGIN` | **não definir** (a validação recusa em produção) | — |
