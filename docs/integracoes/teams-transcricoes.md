# Teams: ligar o acesso às transcrições para o Omni

> Escrito em 05/11/2026. Precisa de: **Administrador do Teams** (ou Administrador Global).
>
> **Situação em 10/11/2026:** passo 1 feito — `EnableGraphTranscriptAccess = True`. `EnableAttributedTranscripts = False` (a transcrição não traz o nome de quem fala; o resumo não consegue dizer quem ficou com cada pendência). Falta o passo 3 (teste com uma reunião real).

## Por que

O Omni já lê a agenda das caixas liberadas e liga à missão as reuniões que citam o número dela (aba **Reuniões** da missão). Para fazer o **resumo pela IA**, ele precisa ler a transcrição da reunião pelo Microsoft Graph.

Conferido em 05/11/2026: o Graph encontra a reunião do piloto (a política `Omni-Reunioes` funciona), mas a transcrição responde:

```
403 Forbidden · GraphAccessToTranscriptsDisabled
"Graph API access to transcripts is disabled for this tenant."
```

Desde julho de 2026 a Microsoft tem um controle **do tenant** para o acesso de aplicativos às transcrições, e ele vem **desligado**. Não há como contornar pelo app: só um administrador liga ([Manage transcript API access](https://learn.microsoft.com/en-us/microsoftteams/meeting-transcript-api-access)).

O acesso continua limitado pela política `Omni-Reunioes`: o Omni só lê reuniões **organizadas** pelas pessoas da política (hoje, só o piloto).

## Passo 1 — Ligar o acesso pelo Graph

**Pelo centro de administração do Teams** (admin.teams.microsoft.com):

1. **Reuniões → Configurações de reunião** (*Meetings → Meeting settings*).
2. Em **Acesso à API de transcrição** (*Transcript API access*), ligue **Acesso do Microsoft Graph** (*Microsoft Graph access*).
3. **Salvar**.

O menu pode mudar de nome entre versões do centro de administração. Se não achar, use o PowerShell.

**Ou pelo PowerShell** (módulo `MicrosoftTeams`, o mesmo do Passo 5 de `m365-registro.md`):

```powershell
Import-Module MicrosoftTeams -ErrorAction Stop
Connect-MicrosoftTeams -ErrorAction Stop
Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true
# Conferência: deve mostrar True
Get-CsTeamsMeetingConfiguration | Select-Object EnableGraphTranscriptAccess, EnableAttributedTranscripts
```

`EnableAttributedTranscripts` (nome de quem fala na transcrição) ajuda o resumo a dizer **quem** ficou com cada pendência. Se estiver `False` e a diretoria concordar, ligue também com `-EnableAttributedTranscripts $true`.

A mudança pode levar algumas horas para valer.

## Passo 2 — Transcrição ligada nas reuniões

Na política de reuniões do piloto (**Reuniões → Políticas de reunião** → a política dele → **Gravação e transcrição**), **Transcrição** deve estar ligada. Em cada reunião, alguém precisa **iniciar a transcrição** (… → Gravar e transcrever → Iniciar transcrição), ou ela pode ser ligada nas opções da reunião para começar sozinha.

## Passo 3 — Testar

1. Marque pelo Outlook/Teams do piloto uma reunião do Teams com o **número da missão no título** (ex.: `5851 - alinhamento da mobilização`).
2. Durante a reunião, inicie a transcrição e fale por alguns minutos.
3. Uns 15 minutos depois do fim, o worker procura a transcrição (job `teams-reunioes`, a cada 15 min, de hora em hora por reunião, por até 24 tentativas).
4. Na missão, aba **Reuniões**: com `IA_RESUMO_REUNIAO=ligada` no `.env`, aparecem o resumo, as decisões e as pendências (cada uma vira tarefa com um clique). O resumo também é publicado no **Gerencial** da missão, só no horário útil.

Enquanto o acesso estiver desligado, a reunião aparece na aba com "Acesso às transcrições desligado no Teams", e o worker volta a tentar sozinho depois de ligado.

## O que o Omni guarda

- Da agenda: título, horário, organizador, participantes (nome e e-mail), link do Teams e o motivo do vínculo com a missão. Reunião sem vínculo não entra no banco.
- Da transcrição: **nada**. O texto vai à OpenAI (retenção zero) só para fazer o resumo e é descartado; o Omni guarda o resumo, as decisões e as pendências.
- Quem vê: diretoria e gerentes (mesma regra dos e-mails) e os membros do Gerencial da missão.
