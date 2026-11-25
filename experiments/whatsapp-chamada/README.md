# Prova de chamadas WhatsApp

Experimento local do Omni: chamadas individuais pelo navegador, gravação dos dois lados e diagnóstico da Evolution 2.3.7. O modo padrão tem pareamento próprio; o modo experimental **`CHAMADA_CONEXAO=evolution`** usa uma ponte com o pareamento existente. Não altera o app nem o banco do Omni.

Para experimentar **um único QR da Evolution para mensagens e chamadas**, veja [ativação da ponte](evolution-bridge/README.md). O usuário confirmou em 09/11/2026 chamadas reais recebidas e efetuadas nesse modo, gravações com as duas vozes audíveis e mensagens chegando ao Omni durante/depois da chamada. O restante deste roteiro descreve o modo `CHAMADA_CONEXAO=propria`, que também teve chamadas e gravações reais confirmadas pelo usuário.

## Rodar

Com Go 1.27 instalado, na raiz desta worktree:

```sh
npm run chamada:poc
```

Abra **http://127.0.0.1:8096** no Chrome ou Edge e use fones. Não depende de `npm install`, Postgres, login Microsoft nem do servidor web do Omni. A primeira execução baixa os módulos Go e compila o serviço.

Sem Go, em Linux com Docker Compose:

```sh
npm run chamada:docker
```

O contêiner também escuta somente em `127.0.0.1:8096`. O Compose usa a rede do host para alcançar a Evolution local; não adiciona o experimento às redes ou aos volumes existentes. Para parar: `docker compose -f docker-compose.chamada.yml down`. O volume `omni-chamada-poc_chamada-poc-data` preserva os dados entre reinícios. Para apagá-los, pare com `down --volumes`.

## Simulação sem WhatsApp

O padrão é `CHAMADA_MODO=simulado`. Nenhuma conexão é feita com o WhatsApp.

1. Clique em **Conectar linha** e **Ativar microfone**; autorize o navegador.
2. Digite um número fictício com DDI, DDD e número, somente dígitos.
3. Marque o aviso da gravação e clique em **Ligar**.
4. O lado remoto fica em silêncio. Para verificar a saída de som, marque **Reproduzir tom de teste (simulação)**; o sinal de 440 Hz fica desligado por padrão. Fale para testar o canal do microfone na gravação.
5. Teste **Silenciar** e **Encerrar**. Reproduza ou baixe o WAV.
6. Teste também **Simular recebimento**, **Atender e gravar** e **Rejeitar**.

O microfone permanece ligado entre as chamadas até você desligá-lo ou fechar a página. Só é gravado durante uma chamada ativa. Ao desconectar o áudio do navegador, o serviço encerra a chamada que estava sob seu controle. Uma única aba controla o microfone.

## Teste com WhatsApp

Crie a configuração **deste experimento**, sem copiar o `.env` da raiz do Omni:

```sh
cp experiments/whatsapp-chamada/.env.example experiments/whatsapp-chamada/.env
```

Edite o arquivo:

```dotenv
CHAMADA_MODO=teste
CHAMADA_LINHA_TESTE=DDIDDDNUMERODALINHA
CHAMADA_NUMEROS_TESTE=DDIDDDNUMERODOOUTROAPARELHO
```

Substitua os valores por **dígitos**, sem `+`, espaços ou pontuação. Separe vários destinos por vírgula, sem espaços. Use somente aparelhos de teste controlados pela equipe. O serviço recusa iniciar em modo `teste` sem linha e destinos; depois do QR, também confere se a conta pareada é a linha configurada.

Algumas contas brasileiras são identificadas pelo WhatsApp no formato antigo, sem o nono dígito. A conferência da linha e dos contatos permitidos reconhece essa equivalência mantendo DDI, DDD e os oito dígitos originais. O número digitado na configuração permanece inalterado. Essa mesma regra é usada no diagnóstico da Evolution.

Reinicie, clique em **Conectar linha** e leia o QR pelo WhatsApp da linha de teste em **Aparelhos conectados → Conectar aparelho**. O serviço cria uma sessão própria em SQLite; não importa nem modifica as credenciais Baileys da Evolution. Se parear outra linha por engano, remova esse aparelho no celular e apague a sessão local antes de repetir.

Chamadas recebidas de contatos fora da lista, grupos e chamadas que já chegam com vídeo não são atendidas nem rejeitadas automaticamente pelo experimento. Uma identidade `@lid` precisa ser resolvida para um telefone permitido; sem essa correspondência, não é atendida. O aviso marcado na tela registra uma confirmação do operador: **não reproduz um anúncio de gravação para o cliente**. Avise os participantes antes do teste.

O motor upstream envia uma sinalização inicial (`preaccept`) antes de a aplicação decidir atender; isso não equivale a aceitar a conversa de voz. O efeito dessa sinalização sobre os outros aparelhos faz parte da homologação. Se uma chamada individual passar para grupo ou vídeo, a POC solicita seu encerramento.

## Evolution: antes, durante e depois

Use a Evolution de desenvolvimento e uma instância pareada com a **mesma linha de teste**. Acrescente à configuração da POC:

```dotenv
CHAMADA_EVOLUTION_URL=http://127.0.0.1:8085
CHAMADA_EVOLUTION_KEY=CHAVE_DA_EVOLUTION_DE_TESTE
CHAMADA_EVOLUTION_INSTANCIA=NOME_DA_INSTANCIA_DE_TESTE
```

A chave fica só no servidor. **Consultar Evolution** faz exclusivamente:

- `GET /instance/fetchInstances?instanceName=…`
- `GET /settings/find/{instance}`
- `GET /webhook/find/{instance}`

O painel mostra estado, correspondência da linha, rejeição automática, contagem de mensagens quando disponível e horário da consulta. O relatório nunca contém chave, URL do webhook nem o corpo integral das respostas. Os diagnósticos ficam em memória até reiniciar; baixe o relatório antes de parar.

`rejectCall` precisa estar desligado na instância de teste; a POC apenas informa essa configuração. O serviço recebe seus próprios eventos de chamada e não depende do evento `CALL` no webhook da Evolution. As consultas comprovam alcance e configuração; **a entrega de mensagens precisa ser observada no Omni e no celular**.

Roteiro de homologação: [docs/integracoes/whatsapp-chamada-poc.md](../../docs/integracoes/whatsapp-chamada-poc.md).

## Dados e limites

- HTTP, cookie de sessão e WebSocket restritos a loopback e à mesma origem. Não publique este painel, não use proxy reverso e não o conecte à produção.
- Uma linha, um operador e uma chamada por vez. Até 45 segundos aguardando resposta; até 600 segundos de chamada ativa (configurável entre 1–600).
- PCM a 16 kHz, mono por direção, quadros de 60 ms. O navegador precisa aceitar `AudioContext` a 16 kHz. A ligação usa uma ponte PCM por WebSocket no computador local; não há gateway WebRTC/SIP pronto para uso remoto.
- A reprodução espera uma reserva de dois quadros (120 ms) e suaviza as bordas quando o som começa ou faltam pacotes, para reduzir estalos. Ao trocar ou encerrar a chamada, o áudio pendente é descartado.
- A reprodução e **Baixar gravação** misturam os dois participantes nos dois lados do fone, inclusive para gravações já salvas. A mistura usa a média dos canais para evitar saturação. **Baixar canais separados** entrega o WAV original de 16 bits: atendente à esquerda e cliente à direita. O relógio do servidor preenche intervalos com silêncio e preserva a posição relativa dos canais. Não se trata de sincronização precisa de estúdio.
- Dados em `experiments/whatsapp-chamada/data/` ao rodar com Go, ou no volume próprio ao usar Docker. Pasta com permissão `0700`, gravações e metadados `0600`; sessões e arquivos ficam fora do Git e da imagem.
- Retenção padrão de 24 h, configurável entre 1–168 h em `CHAMADA_RETENCAO_HORAS`. Limpeza na partida e a cada hora enquanto o serviço roda. Também é possível apagar cada gravação pelo painel.
- Gravações só aparecem para reprodução depois do encerramento. Uma queda abrupta do processo pode deixar um WAV parcial sem cabeçalho final; não há recuperação de gravação após crash nesta POC.
- Chamadas feitas diretamente no celular não são gravadas. Não há transcrição, resumo, grupos, múltiplas linhas nem integração com o banco ou login do Omni nesta etapa.

## Dependências e verificações

O motor é [meowcaller](https://github.com/purpshell/meowcaller), licença MIT, fixado no commit `c48c3e2a243c672c942cbf0c941d14161720d540`. Essa versão utiliza `github.com/polymorfa/hypermeow` (derivado de whatsmeow); as versões e hashes estão em `go.mod`/`go.sum`. O adaptador compila sem bibliotecas nativas de áudio ou microfone no servidor. Não usa o submódulo `audio/malgo` dos exemplos upstream.

```sh
cd experiments/whatsapp-chamada
go test -race ./...
go vet ./...
node --test audio-worklet.test.mjs
CGO_ENABLED=0 go build -o /tmp/chamada-poc .
```

Os testes verificam áudio dos dois canais, WAV, histórico após reinício, fila limitada, regras de destino/duração, isolamento de origem/sessão, uma chamada por vez, comandos atrasados e diagnóstico da Evolution contra um servidor de contrato. O modo simulado permite testar a ponte de áudio sem ligar para ninguém. **Essas verificações não comprovam chamadas reais nem convivência estável no mesmo número.**

Conferido em 05/11/2026: 10 testes passaram com o detector de condições de corrida, `go vet` passou e a imagem Docker compilou e subiu em modo simulado. No Chromium, uma fonte de microfone controlada e o tom remoto produziram áudio não nulo nos dois canais de um WAV estéreo a 16 kHz; o arquivo também foi reproduzido pelo painel. O roteiro com Android, iPhone e Evolution permanece pendente.

Conferido em 09/11/2026: o tom automático foi substituído pela opção explícita de teste, com volume menor e transições suaves. Passaram os 12 testes Go com `-race`, `go vet` e os 3 testes do processador de áudio com Node. No Chromium, as medições da saída confirmaram silêncio nas chamadas simuladas realizadas e recebidas, som ao ativar a opção e silêncio novamente ao desligá-la. A gravação do atendimento também manteve o canal remoto em silêncio. Os testes do processador cobrem reserva de áudio, continuidade entre pacotes, falta de pacotes, limpeza entre chamadas e captura PCM com silêncio do microfone.

Escuta das gravações ajustada no mesmo dia: reprodução e download padrão agora misturam as vozes nos dois lados do fone, sem regravar os arquivos existentes. Passaram os 15 testes Go com `-race` e `go vet`, incluindo mistura sem saturação, arquivos existentes, preservação do original e requisições HTTP Range. No Chromium, uma gravação com sinal somente à esquerda foi reproduzida com áudio igual nos dois canais e com a mesma duração; a opção de canais separados preservou o sinal original.

Pareamento real conferido em 09/11/2026: o WhatsApp aceitou o QR e salvou a sessão, mas devolveu a identidade da linha no formato sem o nono dígito. A comparação literal da POC recusava esse retorno. A conferência foi corrigida e a linha reconectou reutilizando a sessão existente. Passaram os 19 testes Go com `-race` e `go vet`, incluindo equivalência de números, recusa de outros contatos e preservação das mensagens específicas de erro. Expiração de QR, falha de pareamento e recusa de conexão agora recebem mensagens próprias; a tela distingue o QR aceito da autenticação concluída. Chamadas de voz reais e convivência com a Evolution continuam no roteiro de homologação.
