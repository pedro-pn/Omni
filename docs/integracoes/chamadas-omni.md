# Chamadas pessoais no Omni — desenvolvimento

Regras confirmadas pelo usuário em 09/11/2026: o app está em desenvolvimento, sem instalação em produção. Cada pessoa liga e atende pelo próprio WhatsApp já conectado ao Omni. A permissão de gravar é concedida por usuário. As gravações são privadas, com compartilhamento individual e revogável com outras pessoas do Omni.

## Comportamento

- A aba **Chamadas** lista somente os números dos quais a pessoa é responsável. Nas conversas individuais desses números aparece **Ligar pelo meu WhatsApp**. Participar da visualização de uma linha permite continuar lendo suas mensagens, mas não controlar chamadas.
- **Conectar meu WhatsApp** utiliza o pareamento da Evolution. Não cria outro aparelho nem exige um segundo QR. O microfone é ativado separadamente pelo navegador.
- É possível ligar e atender sem gravar. A administração habilita a permissão em **Administração → Pessoas → Pode gravar as próprias ligações do WhatsApp** (12/11/2026; antes ficava em Administração → WhatsApp, que deixou de existir). Mesmo com a permissão, cada ligação exige a caixa **Gravar (vou avisar os participantes)** marcada — desde 24/11/2026 ela já vem marcada para quem tem a permissão (desmarca quem não quer gravar). A confirmação não reproduz um anúncio de voz.
- **Gravar ou pausar durante a ligação** (24/11/2026): na barra da chamada e no painel, "Pausar gravação" e "Gravar"/"Retomar gravação" (comando `record` do serviço de voz). Ligar no meio da ligação pede de novo a confirmação do aviso; o trecho pausado fica em silêncio no arquivo. A ligação continua "com gravação" mesmo se terminar pausada (`recording` é "houve gravação"; `recordingActive`, "gravando agora") — o Omni guarda o que foi gravado.
- Trocar de tela no Omni mantém a chamada e mostra uma barra para voltar aos controles. Uma segunda aba não pode assumir o áudio já aberto. A sessão de controle é renovada pelo servidor; se o usuário sair, perder autorização ou fechar o app, a chamada é encerrada quando o áudio desconecta ou a autorização expira.
- A pessoa vê suas próprias chamadas e gravações recebidas por compartilhamento. **Compartilhar** dá acesso somente às pessoas marcadas; desmarcar revoga novas leituras. Quem recebe não pode compartilhar novamente, apagar ou administrar o acesso. Administração e diretoria não recebem acesso implícito aos áudios.
- A troca do responsável por um número não transfere gravações anteriores. Excluir uma gravação revoga os compartilhamentos antes da remoção física do arquivo.

- **Em qualquer tela:** as chamadas e os eventos ao vivo ficam na raiz do app (`apps/web/src/components/chamadas/CamadaChamadas.tsx`), numa instância só. A ligação toca também em Administração, Conta e Integrações, e a chamada em andamento não cai ao trocar de página. Botões para ligar em cada conversa, cartão de chamada recebida com toque, notificação do sistema com a aba em segundo plano, barra da chamada, recentes e aviso de **chamada perdida** no sino (`0033_chamadas_avisos.sql`).
- **Linha sempre pronta:** com "Receber ligações no Omni" ligado, o servidor renova a linha a cada 5 s enquanto o Omni estiver aberto (o navegador reduz os temporizadores de abas escondidas) e a reconecta se cair, no máximo a cada 30 s. Um ponto verde em Chamadas indica a linha pronta.

## Resumo das ligações pela IA

**Só sob pedido** (decisão de 10/11/2026): nada vai à OpenAI sem o dono da gravação clicar em **Resumir com IA** (em Chamadas → Recentes ou na linha da ligação na conversa; `app.pedir_resumo_chamada`, migration 0039 — quem recebeu a gravação compartilhada não pede). Com `IA_RESUMO_CHAMADA=ligada` (worker, junto de `OPENAI_API_KEY`, `CHAMADAS_SERVICO_URL` e `CHAMADAS_SERVICO_KEY`), o job `chamadas-resumo` (a cada 1 min; `apps/worker/src/chamadas/resumo.ts`, migration 0038) pega as ligações pedidas, busca o áudio no serviço de voz, junta os dois canais em mono (16 kHz; cabe no limite de 25 MB até ~13 min), transcreve (`OPENAI_TRANSCRICAO_MODEL`, padrão `gpt-4o-transcribe`) e resume (`OPENAI_MODEL`; instruções em `packages/core/src/ia/chamada.ts`). Áudio com menos de 3 s ou transcrição com menos de 30 caracteres vira "sem fala" e não vai ao resumo. Até 3 tentativas por ligação; sem crédito na OpenAI, a rodada para.

- **Transcrição e resumo guardados** (transcrição desde 13/11/2026, migration 0062): o banco guarda a transcrição (`whatsapp_calls.transcript`, lida à parte por `transcricaoDaChamada`) e o resumo (resumo, combinados e pendências), visíveis para quem já ouve a gravação (dono e com quem foi compartilhada). Excluir a gravação apaga os dois (gatilho no banco); vencida, o worker apaga a transcrição junto do arquivo. Ligações resumidas antes disso: o dono pode "Transcrever de novo". O worker só lê as colunas necessárias e só grava as do resumo e a transcrição.
- **Ligações na conversa:** aba **Ligações** dentro de cada conversa com pessoa (`ligacoesDaConversa`), com o mesmo item da aba Chamadas (`ItemDeLigacao.tsx`: gravação, compartilhar, excluir, resumo e transcrição).
- O resumo aparece em **Chamadas → Recentes** e na linha da ligação dentro da conversa; cada pendência vira tarefa na caixa pessoal com um clique (id fixo: não duplica).
- Cada chamada à OpenAI fica em `llm_calls` (`chamada_transcricao`, `chamada_resumo`), sem o texto. Autorizado pelo dono do produto em 10/11/2026; consta do registro de LGPD (`docs/producao/lgpd-ropa-dpa.md`).

## Testes reais (10/11/2026)

Chamadas recebidas de um iPhone para a linha conectada: atendidas no Omni, com áudio nos dois sentidos, inclusive deixando tocar ~20 s antes de atender; gravação de uma chamada recebida ouvida com os dois lados. Problemas encontrados e corrigidos:

1. **Chamada recebida não aparecia (linha caída):** a renovação da linha dependia de um temporizador do navegador; com o Omni em segundo plano, a linha expirava em 20 s e a oferta chegava sem ninguém escutando. Passou para o servidor (acima).
2. **Chamada recebida descartada em silêncio:** o WhatsApp do iPhone manda a chave da chamada junto de `messageContextInfo` (metadados de aparelhos). A ponte só aceitava a chave sozinha e recusava a decifração, e o motor descartava a oferta. A ponte aceita agora a chave com esses metadados, e continua recusando qualquer conteúdo de conversa, sozinho ou junto da chave (`bridge.test.mjs`).
3. **Permitir gravação não salvava:** a caixa de Administração → WhatsApp lia o valor depois de o React restaurá-la e gravava sempre "não". Corrigido na tela.
4. **Eco leve da voz da outra pessoa na gravação (13/11/2026):** a gravação guarda o microfone que o Omni envia (canal esquerdo) e a voz recebida (direito). A voz da outra pessoa era tocada direto pelo Web Audio, que o cancelamento de eco do Chrome não usa como referência de forma confiável: saía na caixa de som, voltava pelo microfone e era enviada de novo (a outra pessoa também ouvia o eco). Agora ela toca por uma conexão WebRTC interna do navegador (`apps/web/src/components/chamadas/saida-com-eco-cancelado.ts`), com volta ao caminho antigo se o WebRTC falhar. Com fone de ouvido, o eco não acontecia. Gravações antigas continuam como estão.

**Diagnóstico:** `CHAMADA_DIAGNOSTICO=1` (padrão `0`) no `docker-compose.chamadas-omni.yml` registra por onde a chamada passou e por que foi ignorada, além de avisos do motor e do cliente, sem áudio e com números mascarados. Use só para investigar e desligue depois.

**Observado e não corrigido:** um aparelho antigo da mesma conta (pareamento da POC ou WhatsApp Web/Desktop) envia `reject` logo após cada oferta; não impediu o atendimento. Conferir em WhatsApp → Aparelhos conectados.

## Arquitetura

`0032_chamadas.sql` acrescenta permissões, histórico e compartilhamentos com RLS. O servidor deriva pessoa, linha e permissão da sessão autenticada; o navegador não escolhe o dono da chamada. Cada leitura de áudio, inclusive ao avançar o player, verifica novamente o acesso no banco.

O serviço Go tem um estado separado por número/dono, diretórios privados e uma API interna autenticada. O áudio usa tickets de uso único, válidos por 30 segundos, vinculados à linha e à origem do app. O navegador acessa `/omni/audio` pelo proxy de desenvolvimento do Vite; não recebe chaves internas ou credenciais da Evolution. Uma verificação independente do fluxo de áudio renova a autorização a cada 5 segundos; sem renovação por 20 segundos, a linha é desconectada do motor de voz.

Eventos de início/fim vão para `/api/chamadas/eventos` com chave interna. O banco verifica a propriedade da linha e a permissão de gravação. Eventos finais são reenviados em caso de falha, e metadados locais permitem recuperar o envio após reiniciar. Os WAVs permanecem no volume privado do serviço, separados dos dados da POC anterior; o Postgres guarda apenas o histórico e as referências. A retenção configurada do áudio continua valendo e o histórico permanece no banco.

A extensão da Evolution permite várias linhas simultâneas no modo `OMNI_CHAMADA_PONTE=omni`. Cada inscrição pertence a uma única sessão Baileys, com geração e lease próprias. O fechamento de uma linha não entrega eventos à outra. A segunda tentativa de assumir a mesma linha é recusada, inclusive entre o painel antigo da POC e o Omni.

## Desenvolvimento principal em `master`

Integrado ao checkout principal em 09/11/2026. A migration `0032_chamadas.sql` foi aplicada no banco local `omni`. O painel usa **http://localhost:3000**, o serviço de voz escuta em `127.0.0.1:8098` e a ponte da Evolution em `127.0.0.1:8097`. A Evolution conserva o pareamento existente. O painel isolado anterior foi parado, preservando seus volumes e gravações.

As configurações privadas ficam no `.env` da raiz e em `experiments/whatsapp-chamada/.env.omni`, ambos ignorados pelo Git. No primeiro ficam `CHAMADAS_HABILITADAS=on`, `CHAMADAS_SERVICO_URL=http://127.0.0.1:8098` e `CHAMADAS_SERVICO_KEY`; o segundo contém a mesma chave em `CHAMADA_OMNI_KEY`, `CHAMADA_OMNI_ORIGIN=http://localhost:3000`, o callback em `http://127.0.0.1:3000/api/chamadas/eventos` e a configuração privada da ponte. O modo real de desenvolvimento continua restrito aos números de teste configurados.

Para retomar esse ambiente, a partir da raiz principal e com os arquivos privados já configurados:

```sh
node --env-file=.env node_modules/tsx/dist/cli.mjs packages/db/src/cli/migrate.ts
docker compose --env-file .env --env-file experiments/whatsapp-chamada/.env.omni \
  -f docker-compose.whatsapp.yml -f docker-compose.chamada-evolution.yml \
  up -d --no-build evolution
docker compose -f docker-compose.chamadas-omni.yml up -d --no-build
npm run dev
```

As imagens precisam ter sido construídas conforme as instruções abaixo. Conserve o override de chamadas ao recriar a Evolution para manter a ponte habilitada.

Entre com a conta responsável pelo número, abra **Chamadas**, clique em **Conectar meu WhatsApp** e habilite o microfone. A ativação não concede permissão de gravação automaticamente; a administração pode habilitá-la na configuração do número. Depois, a pessoa escolhe gravar e confirma o aviso em cada ligação.

A conferência da ativação validou a autorização do responsável no banco, a conexão real à ponte usando o pareamento existente, o WebSocket de áudio pelo painel principal e a recusa de reutilização do ticket. Não efetuou ligações. O teste real da nova interface entre dois usuários continua pendente.

## Executar em uma worktree alternativa

1. Instale dependências e aplique a migration no banco **de desenvolvimento** usado pelo app. Configure o ambiente do Omni normalmente. Para usar a configuração já existente em `../omni/.env`, sem copiá-la:

   ```sh
   npm ci
   node --env-file=../omni/.env node_modules/tsx/dist/cli.mjs packages/db/src/cli/migrate.ts
   ```

2. Copie `experiments/whatsapp-chamada/omni.env.example` para `experiments/whatsapp-chamada/.env.omni` e proteja com `chmod 600`. Gere uma chave com `openssl rand -hex 32` e coloque o mesmo valor em **CHAMADA_OMNI_KEY** e **CHAMADAS_SERVICO_KEY**. Essa chave é diferente da chave da ponte. O exemplo começa em **simulado**, sem chamadas ao WhatsApp.

3. Inicie o serviço de voz:

   ```sh
   docker compose -f docker-compose.chamadas-omni.yml up -d --build
   ```

4. Inicie o Omni desta worktree em outra porta, conservando o desenvolvimento principal em 3000:

   ```sh
   cd apps/web
   node --env-file=../../../omni/.env \
     --env-file=../../experiments/whatsapp-chamada/.env.omni \
     ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3001
   ```

5. Abra **http://localhost:3001**, entre com sua conta e abra **Chamadas**. A origem deve coincidir exatamente com `APP_ORIGIN` e `CHAMADA_OMNI_ORIGIN`; o serviço recusa um ticket emitido para outra origem. Em simulação, aparece uma indicação na tela e nenhum telefone real toca.

O `.env.omni`, os tickets, as sessões e as gravações não entram no Git. O volume `omni-chamadas_chamadas-omni-data` conserva os áudios entre reinícios. Não troque o banco usado por uma instalação já aberta sem também reiniciar o serviço com um diretório/volume correspondente: os IDs de pessoas e linhas pertencem ao banco que os criou.

## Usar a Evolution real de desenvolvimento

Depois da conferência em simulação:

1. Em `.env.omni`, defina `CHAMADA_MODO=teste`, `CHAMADA_CONEXAO=evolution`, a URL da ponte e **a mesma CHAMADA_PONTE_TOKEN presente na Evolution**. Configure `CHAMADA_NUMEROS_TESTE` com os telefones controlados pela equipe. Inclua ambos os aparelhos quando ambos forem donos de linhas testadas. Os limites de teste continuam ativos.
2. Construa a imagem atualizada da ponte e recrie a Evolution local com o override, carregando também `.env.omni` por último:

   ```sh
   docker build -t omni-evolution:2.3.7-presence.1 deploy/evolution
   docker build -t omni-evolution:2.3.7-chamada-poc experiments/whatsapp-chamada/evolution-bridge
   docker compose --env-file ../omni/.env \
     --env-file experiments/whatsapp-chamada/.env.omni \
     -f docker-compose.whatsapp.yml -f docker-compose.chamada-evolution.yml \
     up -d --no-build --no-deps evolution
   docker compose -f docker-compose.chamadas-omni.yml up -d --force-recreate
   ```

3. Confira que cada número está vinculado à pessoa correta no Omni e pareado na Evolution. Desconecte o painel antigo da POC antes de assumir a mesma linha no Omni. Não apague sessões nem volumes para fazer essa troca.
4. Teste com dois usuários: cada um deve ver somente sua linha, receber somente as próprias chamadas e ouvir somente suas gravações. Compartilhe uma gravação de A com B, confira o player de B e depois revogue; confirme também que um administrador sem compartilhamento não pode ouvir.

O fluxo real anterior validou o motor de áudio e a ponte com o mesmo pareamento. A nova interface e o isolamento entre pessoas exigem esta homologação real adicional. Reconexão, atendimento pelo celular e compatibilidade Android/iPhone continuam na matriz da POC.

## Verificações

Conferido em 09/11/2026: build, tipos e 368 testes do monorepo aprovados; testes Go com `-race` e `vet`; nove testes da ponte, incluindo duas linhas simultâneas, e integração Go ↔ Baileys sem rede externa. No navegador, usando somente `omni_test` e áudio simulado, foram verificados chamada efetuada com gravação, chamada recebida atendida sem gravação, estado isolado entre duas pessoas e arquivo de 52 segundos com sinal nos dois canais e amplitudes iguais. O destinatário recebeu HTTP 404 antes de compartilhar, HTTP 206 com leitura parcial após compartilhar e novamente HTTP 404 depois da revogação. O navegador do destinatário exibiu apenas sua própria linha e não mostrou controles de compartilhamento para o áudio recebido.

Essa verificação não realizou chamadas reais e não reiniciou a Evolution que estava em uso.

- `npm run build`, `npm run typecheck`, `npm test` (Postgres de teste ativo).
- `go test -race ./...` e `go vet ./...` no experimento.
- `bash experiments/whatsapp-chamada/evolution-bridge/test.sh`: criptografia real do Baileys com identidades efêmeras, duas linhas isoladas e lease exclusiva por linha, sem rede externa.
- Navegador em simulação: ligar com gravação, player, compartilhamento, revogação, linha de outro usuário ausente e estabilidade do áudio por mais de 20 segundos.

O proxy `/omni/audio` do servidor de desenvolvimento do Vite vale só no desenvolvimento; no staging e na produção quem encaminha é o Caddy (abaixo).

## Staging e produção (11/11/2026)

Perfis `whatsapp` + `chamadas` do `deploy/docker-compose.prod.yml` (variáveis em `deploy/production.env.example` e `deploy/staging.env.example`; passo a passo em `docs/producao/guia-producao.md`):

| Peça | Desenvolvimento | Staging / produção |
|---|---|---|
| Modo do serviço de voz (`CHAMADA_MODO`) | `teste` (só `CHAMADA_NUMEROS_TESTE`) | staging `teste`; produção **`producao`**: qualquer contato com número válido, ligação de até 4 h (padrão 1 h, e a gravação acompanha a duração), gravação guardada por **5 anos** (decisão de 11/11/2026; até 10 anos; o banco aceita o mesmo teto, migration 0050); recusa lista de teste e origem sem https |
| Ponte na Evolution (`OMNI_CHAMADA_PONTE`) | `omni` | staging `omni`; produção **`producao`** (várias linhas, qualquer contato) |
| Endereços internos | tudo em `127.0.0.1` (rede do computador) | nomes dos serviços na rede interna do compose: `voz:8098` (API, só web e worker, com chave), `evolution:8097` (ponte, com token e `Host` conferido), `web:3000` (eventos). Simulação e POC sozinha continuam só em loopback |
| Áudio do navegador | proxy do Vite | Caddy `handle /omni/audio` → `172.17.0.1:8086` (staging 8088), porta do serviço que **só** responde `/omni/audio` e `/health` (`CHAMADA_ESCUTAR_AUDIO`); a API interna fica fora |
| Imagem da Evolution | `omni-evolution:2.3.7-chamada-poc` | `deploy/evolution/Dockerfile.chamadas` (presença + ponte; inerte sem `OMNI_CHAMADA_PONTE`; roda os testes da ponte no build) |
| Gravações | volume `omni-chamadas_chamadas-omni-data` | **SharePoint, cifradas** (site OmniAnexos, `Gravacoes/AAAA/MM/<id>.m4a.cifrado`, M4A AAC 48 kbps cifrado com AES-256-GCM em blocos de 64 KiB, uma chave por gravação embrulhada por `GRAVACOES_CHAVE_MESTRA`; `@omni/integrations/gravacoes`): o worker envia ao fim da ligação e apaga o WAV do volume `chamadas_data` (job `chamadas-arquivar`, migrations 0052–0053); o web decifra só o trecho pedido pelo player; excluir apaga a chave na hora (gatilho) e o arquivo de vez, sem lixeira |

**Ensaio local em 11/11/2026** (compose de produção, projeto isolado, sem número pareado): todos os serviços no ar; na porta publicada, `/health` 200, `/internal/control` 404 e áudio sem a origem do Omni 403; web → `voz:8098` sem chave 401 e com chave 200; voz → `evolution:8097` alcançou a ponte ("o número precisa estar conectado"); bilhete de áudio com a origem do Omni abriu o WebSocket (101), origem errada 403, bilhete reutilizado 401. Testes: Go (`go test ./...`, novos `producao_test.go`), ponte (10, incluindo produção), integração Go ↔ Baileys sem rede.

**Falta com número real:** ligar e atender no staging (modo `teste`) e depois na produção, de iPhone e Android, com duas pessoas, gravação, compartilhamento e revogação (lista no guia, passo 10).
