# WhatsApp pela Evolution própria do Omni

> Escrito em 05/11/2026. Decisão: `docs/adr/0004-whatsapp.md` (Evolution com QR code, servidor próprio do Omni).

## Como funciona

A Evolution é um programa pronto (imagem Docker `evoapicloud/evolution-api`), não um app que escrevemos. O Omni roda a **sua própria** Evolution, separada da do Prisma (chave geral, banco e Redis próprios), com a mesma versão (2.3.7) e o mesmo patch de presença do Prisma (`deploy/evolution/`, copiado de `crm-filtrovali/infra/whatsapp/evolution`).

| Peça | Onde | O que faz |
|---|---|---|
| Evolution do Omni | `deploy/evolution/` (imagem), `docker-compose.whatsapp.yml` (dev), perfil `whatsapp` de `deploy/docker-compose.prod.yml` | Mantém a sessão de cada número pareado por QR, recebe e envia mensagens |
| Cliente | `packages/integrations/src/whatsapp/` | Interface `WhatsApp` (provedor trocável), `EvolutionClient`, leitura dos eventos do webhook |
| Webhook | `apps/web/src/routes/api/whatsapp/webhook.ts` | Confere o segredo (`x-omni-webhook-key`), lê só o necessário e grava pelas funções `app.whatsapp_registrar_*` (migration 0027) |
| Conversas → "Conecte seu WhatsApp" e Meu WhatsApp (menu do perfil) | `apps/web/src/components/conversas/Conversas.tsx` (`ConectarWhatsApp`), `apps/web/src/components/conta/MeuWhatsApp.tsx`, `apps/web/src/lib/meu-whatsapp-fns.ts`, `apps/web/src/lib/whatsapp-fns.ts` | **Cada pessoa adiciona e administra o próprio número** (12/11/2026, migrations 0055–0056): sem número, Conversas já mostra o QR code; em Meu WhatsApp, conectar de novo, atualizar, histórico dos grupos, reconfigurar, desconectar e remover. A Administração não tem acesso aos números das pessoas; só define, em Administração → Pessoas, quem pode gravar as próprias ligações |
| Worker `whatsapp-estado` | `apps/worker/src/whatsapp/estado.ts` | A cada 5 min confere o estado dos números (o webhook avisa na hora; isto cobre o que se perdeu) |

**Quem vê as conversas de um número:** só o responsável pelo aparelho (decisão de 12/11/2026, migration 0054: antes também a diretoria e pessoas incluídas pela administração). A administração cadastra e pareia, mas não lê as conversas; a diretoria também não. Os grupos ligados a uma missão aparecem, dentro da missão, para quem vê o Interno dela. Avisos no celular das mensagens recebidas: só o responsável.

**O que o Omni guarda:** conversa (JID, telefone, nome) e mensagens com tipo, texto/legenda e nome do arquivo. Mídia ainda não é baixada. A chave da instância que a Evolution põe no corpo do webhook é descartada; o corpo nunca vai para log.

**Travas:** envio em ensaio por padrão (`WHATSAPP_ENVIO`; `real` recusado fora da produção); Interno e Gerencial nunca saem pelo WhatsApp; um aparelho em um número ativo só; a Evolution não sobe sem chave forte; nenhuma porta da Evolution exposta na produção.

## Desenvolvimento

1. O `.env` precisa de `WHATSAPP_EVOLUTION_URL=http://127.0.0.1:8085`, `WHATSAPP_EVOLUTION_KEY` e `WHATSAPP_WEBHOOK_SECRET` (dois valores diferentes, `openssl rand -hex 32`), `WHATSAPP_WEBHOOK_URL=http://host.docker.internal:3999/api/whatsapp/webhook` e `WHATSAPP_ENVIO=ensaio`.
2. `npm run whatsapp:up` (primeira vez: baixa e monta a imagem, alguns minutos). `npm run whatsapp:down` para parar (as sessões ficam no volume).
3. Reinicie `npm run dev` e `npm run dev:worker` para lerem as variáveis.
4. Entre com a conta da pessoa dona do **celular de teste**, abra **Conversas** e leia o QR code que aparece (nunca um número de cliente nem um que esteja no Prisma).

O Omni de desenvolvimento escuta só em `127.0.0.1:3000` (o login de desenvolvimento não pode ficar exposto). O serviço `webhook-repasse` do compose escuta só na ponte do Docker (`172.17.0.1:3999`) e entrega no `127.0.0.1:3000`, para o webhook da Evolution chegar.

## Produção (VPS)

1. No `deploy/.env.production`, acrescente (sem imprimir os valores):

   ```sh
   umask 077
   printf 'WHATSAPP_EVOLUTION_KEY=%s\nWHATSAPP_WEBHOOK_SECRET=%s\nEVOLUTION_POSTGRES_PASSWORD=%s\nWHATSAPP_EVOLUTION_URL=http://evolution:8080\nWHATSAPP_WEBHOOK_URL=http://web:3000/api/whatsapp/webhook\nWHATSAPP_ENVIO=ensaio\n' \
     "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> deploy/.env.production
   ```

2. Suba com o perfil: `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production --profile whatsapp up -d --build`.
3. Confira: `docker compose … ps` (evolution `healthy`); nenhuma porta da Evolution aparece publicada.
4. Pareie os números pela Administração do Omni, um de cada vez, com o responsável pelo aparelho presente.
5. `WHATSAPP_ENVIO=real` só depois do inventário dos números e do comunicado ao time (`docs/producao/lgpd-ropa-dpa.md`).

## Conferido em 05/11/2026 (sem celular)

Evolution do Omni subiu saudável com o patch; API recusa sem chave (401); criar número, configurar webhook e conferir o que ficou gravado, gerar o QR (PNG), estado `conectando`, desconectar e apagar; o contêiner alcança o webhook do Omni e o webhook recusa sem segredo. Pela tela: número criado, QR mostrado e atualizado, removido da Evolution, ações na auditoria.

## Histórico no aparelho (12/11/2026; antes, "opção A" com grupos escolhidos)

O WhatsApp manda o histórico **só no pareamento** (`syncFullHistory`), e a Evolution do Omni o guarda (`DATABASE_SAVE_DATA_HISTORIC=true`). Como no WhatsApp Web, o **navegador do dono do número** baixa **todas as conversas** para o próprio aparelho:

- **Cópia:** com o Omni aberto, `sincronizarHistorico` (`apps/web/src/lib/whatsapp-aparelho.ts`) pede páginas de 200 a `paginaDoHistorico` (`apps/web/src/lib/whatsapp-aparelho-fns.ts`), das mais novas para as mais antigas, e grava no IndexedDB (`omni-whatsapp-<pessoa>`). Continua de onde parou; ao abrir o Omni de novo, confere a página seguinte (o celular manda o histórico aos poucos, e as mensagens novas empurram as antigas para o fim). Uma aba por vez (Web Locks). Andamento no topo da lista de Conversas e em Meu WhatsApp → Histórico.
- **Servidor:** o banco do Omni **não copia as mensagens antigas**; cria só as conversas (nome, data e prévia da última mensagem) pela `app.whatsapp_conversa_do_dono` (migration 0060, só o dono), para aparecerem na lista. As mensagens que chegam ao vivo continuam no banco como antes.
- **Conversa:** junta as mensagens do servidor com as do aparelho sem repetir (`waId`); "Mostrar mensagens anteriores" lê mais do aparelho. Arquivos do histórico: `/api/whatsapp/historico/$numberId/$waId` (só o dono; a Evolution procura o id só dentro da instância do número).
- **Sair do Omni** apaga o histórico de todos os aparelhos deste navegador; **remover o número** também. Em outro computador, baixa de novo.
- **Faltou histórico:** Meu WhatsApp → Histórico → "Desconectar e mostrar o QR code" pede o histórico de novo ao celular; depois, "Baixar de novo".
- O seletor de grupos, a importação (`whatsapp-historico`) e a limpeza da Evolution (`WHATSAPP_EVOLUTION_DB_URL`) saíram: com o WhatsApp só do dono (0054–0056), não há mais o que filtrar. A tabela `whatsapp_history_imports` ficou sem uso.

Mídia antiga aparece como "imagem"/"arquivo"; abrir depende de o WhatsApp ainda ter o arquivo.

## Voz, emojis, plano de fundo e confirmações (13/11/2026)

- **Mensagem de voz:** microfone na resposta (aparece com a caixa vazia): grava no navegador (`apps/web/src/components/conversas/gravador.ts`; Chrome WebM/Opus, Firefox OGG, Safari MP4), mostra o tempo, descarta ou envia. Vai por `/api/whatsapp/arquivo` com `voz=1` (mesmas travas: limite por minuto, `whatsapp_outbox`, `WHATSAPP_ENVIO`) e sai por `message/sendWhatsAppAudio` com `encoding`: a Evolution converte com o `ffmpeg` dela e manda como **mensagem de voz** (OGG/Opus, `ptt`). Até 30 min.
- **Emojis:** painel com categorias e os recentes (só neste navegador), no ponto do cursor (`Emojis.tsx`).
- **Plano de fundo:** botão da paleta no cabeçalho da conversa: cores (com versão escura, `--fundo-*` em `styles.css`) ou outra cor, e um padrão leve (pontos, grade, listras); para **esta conversa** ou **todas** (a da conversa vale sobre a geral). Guardado por pessoa em `whatsapp_fundos` (migration 0061, RLS: só a própria pessoa e só conversa que ela vê), vale em todos os aparelhos dela.
- **✓ enviada, ✓✓ entregue, ✓✓ azul lida:** o webhook grava o status (`app.whatsapp_registrar_status`), agora também quando o WhatsApp manda pelo `@lid`, e avisa a tela na hora (`omni_whatsapp` com `status`; o worker não manda notificação disso). No histórico do aparelho, o status vem do que a Evolution guardou em cada mensagem (`MessageUpdate`).

## Conversa nova

**Nova conversa** (topo da lista de Conversas): os contatos do WhatsApp do número (lidos na hora na Evolution, `contatosDoWhatsApp`; só quem tem número) ou qualquer número digitado (sem DDI e com 10–11 dígitos vale o Brasil). Antes de abrir, `abrirConversaNova` confere no WhatsApp (`chat/whatsappNumbers`; o WhatsApp devolve o endereço certo, às vezes sem o 9) e cria a conversa pela `app.whatsapp_conversa_do_dono`. Envio com as mesmas travas da resposta (`WHATSAPP_ENVIO`, limites por minuto, sem disparo em massa).

## Grupo da missão, resposta e arquivos

- **Ligar à missão:** na conversa, "Ligar à missão" (quem acompanha o número). Quando o nome do grupo cita o número de uma missão ativa, aparece a sugestão "Ligar este grupo à missão?" com **Ligar** e **Não é** (a recusa fica registrada e a sugestão não volta; `missoesNoNomeDoGrupo` em `packages/core/src/whatsapp.ts`). Quem vê o Interno da missão passa a ler **só esse grupo** na aba **WhatsApp** da missão; responder continua sendo de quem acompanha o número.
- **Responder:** caixa de resposta na conversa, com anexo (foto, PDF, Office, áudio ou vídeo até 16 MB; `/api/whatsapp/arquivo`, mesmas travas do texto; o arquivo não fica no Omni, só nome, tipo e tamanho em `whatsapp_outbox`, migration 0030). `WHATSAPP_ENVIO=ensaio` registra em `whatsapp_outbox` e mostra "Ensaio: não enviada"; `real` (só produção) envia pela Evolution. Limite: 10 por pessoa e 20 por número a cada minuto. Interno, Gerencial, IA e e-mail não têm caminho até o WhatsApp (`podeSairPeloWhatsApp` + `whatsapp_outbox.origem`, com teste).
- **Arquivos:** fotos, áudios e vídeos abrem na conversa; documentos baixam. Tudo pelo servidor (`/api/whatsapp/midia/…`, conferido por `app.midia_whatsapp`); nada fica guardado no Omni.
- **Recuperação:** `whatsapp-recuperar` (10 min) relê as últimas 2 h na Evolution e grava o que o webhook perdeu.
- **Uma conversa por pessoa (0048):** o WhatsApp manda a mesma pessoa pelo número (`…@s.whatsapp.net`) ou pelo id de privacidade (`…@lid`). A conversa é sempre a do número quando a Evolution informa (`remoteJidAlt`/`senderPn`); o `@lid` fica em `whatsapp_chats.lid` para reconhecer mensagens e status que chegam só com ele (`app.whatsapp_conversa`; duplicadas antigas juntadas na migration).
- **Nome da agenda que não chegava (17/11/2026):** na Evolution v2.3.7, o `contacts.upsert` (contatos que o celular sincroniza, com o nome salvo na agenda) grava com `createMany(skipDuplicates)`: se o contato já existia (criado antes por uma mensagem, sem nome), o nome era descartado. Na produção, 44 de 828 conversas com pessoa estavam só com o número e nenhum nome existia na Evolution. Patch `deploy/evolution/patch-contatos.mjs` (nos dois Dockerfiles, conferido pelo SHA-256 do `main.mjs` e testado no build por `contatos.test.mjs`, que roda o próprio tratamento corrigido): atualiza o nome dos que já existiam — o da agenda, senão o verificado, senão o do perfil; número no lugar de nome, nunca. Os nomes que já se perderam só voltam quando o celular manda a agenda de novo: **pareando outra vez** (Meu WhatsApp → Histórico → Desconectar e mostrar o QR code); o `whatsapp-perfis` aplica em até 30 min.
- **Nomes que continuavam como número (18/11/2026):** na conta do piloto, 314 de 343 conversas com pessoa tinham o próprio número gravado como nome no Omni (a Evolution põe o número no `pushName` quando não sabe o nome; a importação do histórico e o webhook gravavam isso), e todas as atualizações só preenchiam conversas *sem* nome — o nome da agenda, já certo na Evolution, nunca entrava (93 casos). Outras ~200 conversas estavam só pelo `@lid`, com o nome da agenda guardado na Evolution pelo número. Correção: migration 0069 (`app.nome_de_contato`: número não é nome; o nome da agenda vale sempre, como no WhatsApp Web, menos quando o dono renomeou no Omni — `name_manual`; os "nomes" que eram número foram limpos) e patch `deploy/evolution/patch-lid.mjs` (nos dois Dockerfiles; conferido pelo SHA-256 do `main.mjs` já com o patch-contatos; testado no build por `lid.test.mjs`): `chat/findContacts` traz `lidJid` nos contatos pelo número e `pnJid` nos contatos `@lid`, lidos **só** do mapeamento já guardado na sessão (chaves `lid-mapping`), sem consulta nova ao WhatsApp. O `whatsapp-perfis` dá o número e o nome da agenda à conversa `@lid` (ou junta com a do número). Nomes dados no Omni antes de 18/11 não estavam marcados: se a agenda tiver outro nome, ele passa a valer (renomear de novo fixa).
- **Nome e foto:** `whatsapp-perfis` (30 min) lê a lista de conversas **e a de contatos** da Evolution: o grupo pega sempre o nome atual; o contato, só se não tiver nome, com o **nome salvo na agenda do celular** (a Evolution guarda em `pushName` dos contatos, muitas vezes só na entrada `@lid` da pessoa; antes de 12/11/2026 o Omni lia só as conversas e esses contatos ficavam só com o número). Quando nem a agenda nem o perfil trazem nome, o dono do número dá um nome no cabeçalho da conversa (lápis; `app.whatsapp_renomear_contato`, migration 0057), que a sincronização não sobrescreve; a foto fica só como endereço do WhatsApp e é servida por `/api/whatsapp/foto/$chatId` (quem vê o número; só `https://…whatsapp.net`).

## Conferido em 05/11/2026 (com o celular de teste)

Mensagens de pessoa e de grupo chegaram em tempo real; a foto do grupo abriu pelo servidor; grupo ligado à missão 5851 apareceu na aba WhatsApp da missão; resposta em ensaio registrada e marcada; os dados do teste foram desfeitos.

## Falta

- Parear de novo para receber o histórico e importar os grupos das missões (passo da Administração acima).
- `WHATSAPP_ENVIO=real` só na produção, depois do inventário dos números e do comunicado ao time.

## Ponte de ações do Omni (agenda do celular, adicionar contato, fixar e favoritar)

A Evolution 2.3.7 não expõe em rota o que o WhatsApp Web faz com a agenda e com o fixar/favoritar. A ponte de ações (`experiments/whatsapp-chamada/evolution-bridge/acoes.mjs`, instalada dentro do Baileys da imagem `omni-evolution:2.3.7-chamadas.10`) faz isso pelo próprio socket, só na rede interna, com token:

- **Agenda:** os contatos **salvos** no celular, com o nome salvo (não o nome de perfil). Na primeira leitura de cada sessão, baixa de novo a coleção dos contatos do WhatsApp (`critical_unblock_low`). O worker lê a cada 6 h (`whatsapp-agenda`, tabela `whatsapp_contacts`, migration 0088). Com a agenda lida, quem não está salvo aparece pelo número e o nome de perfil fica discreto ("~ Nome"), como no WhatsApp Web.
- **Adicionar contato** (cabeçalho da conversa e menu da mensagem no grupo): salva na agenda do celular, e por ela em todos os aparelhos.
- **Fixar conversa, favoritar e fixar mensagem:** levados ao celular. Se o celular recusar, ficam só no Omni.

Tudo isso só com `WHATSAPP_ENVIO=real`. Em ensaio, fica só no Omni.

Ligar (produção):
1. Gere um token: `openssl rand -hex 32`.
2. No `deploy/.env.production`: `WHATSAPP_ACOES_URL=http://evolution:8099` e `WHATSAPP_ACOES_TOKEN=<o token>`.
3. Reconstrua a Evolution, o web e o worker: `docker compose … --profile whatsapp up -d --build evolution web worker`.

## Segurança: CVE-2026-48063 no Baileys

A Evolution 2.3.7 (e a 2.3.8) usa o Baileys 7.0.0-rc.9, afetado pelo CVE-2026-48063 (GHSA-qvv5-jq5g-4cgg, nota 9,3): qualquer pessoa podia mandar mensagens de protocolo que só o próprio celular deveria mandar, forjar mensagens e histórico e corromper a sincronização do "app state" com chaves falsas. A correção oficial saiu no 7.0.0-rc12, que traz seis meses de mudanças e dependências novas. Por isso a imagem do Omni aplica no rc.9 só a trava da correção (`deploy/evolution/patch-cve-2026-48063.mjs`, do commit 3beb08ee do Baileys), com teste no build (`cve-2026-48063.test.mjs`). Quando a Evolution passar para um Baileys corrigido, o patch recusa o build (o hash do arquivo muda) e deve sair. A trava sozinha descartava também o que vem do próprio celular (troca de chaves do app state e aviso de histórico chegam com `from` = eu e sem `recipient`, e o rc.9/rc12 marcavam como de outra pessoa): o mesmo script aplica o conserto do rc13 (commit 5ddc231f, `decode-wa-message.js`), com teste. Sem ele, número pareado de novo fica sem chaves, sem agenda e sem histórico.

## Chaves do "app state" depois de reiniciar (patch-chaves-app-state)

A Evolution 2.3.7 grava a chave do app state (AppStateSyncKeyData: agenda, fixar, favoritar…) com `JSON.stringify`, que chama o `toJSON` do protobuf: os bytes da chave (`keyData`) viram texto base64. Na leitura, ela recria a chave com `AppStateSyncKeyData.create(...)`, que não decodifica o base64. A chave vira lixo, e toda coleção dá "bad decrypt" depois que a Evolution reinicia. Antes disso funciona, porque a chave certa fica no cache em memória por alguns minutos. A imagem troca `create` por `fromObject`, que decodifica, em `deploy/evolution/patch-chaves-app-state.mjs`, com teste no build e aplicado depois dos patches que conferem o hash do `main.mjs`. A ponte de ações lê a agenda do servidor sem o resync do Baileys, pulando registro que não abre, e aceita a chave nos dois formatos.
