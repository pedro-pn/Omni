# Microsoft 365 para o Omni (Fase 4): Outlook, SharePoint e Teams

> Escrito em 29/10/2026. Precisa de: **Administrador Global** (ou Administrador de Aplicativos + Administrador do Exchange + Administrador do Teams + Administrador do SharePoint).
> Este é um **segundo registro**, separado do login: `Omni – Integrações`. O login (`Omni`) continua só com `openid/profile/email`.
>
> Princípio: **acesso mínimo e limitado por escopo.** O app nunca recebe acesso a todas as caixas, todos os sites ou todas as reuniões do tenant.

## Situação em 03/11/2026

| Item | Situação |
|---|---|
| Registro `Omni – Integrações` | Criado. ID do aplicativo `<GUID>`; diretório `<GUID>`. Já no `.env` de desenvolvimento (`GRAPH_*`) |
| Certificado | Gerado (`CN=Omni Integracoes Filtrovali`, válido até 02/11/2028); chave em `~/.secrets/omni-graph.key`, fora do repositório. Carregado no registro em 03/11; token conferido com as permissões planejadas (sem `Mail.*` no Entra) |
| Caixas (`Omni - Caixas`) | Só a do piloto (1 caixa). Conferido em 03/11: a do piloto abre; uma fora do grupo dá 403. No Omni, cada caixa também é cadastrada em **Administração → Caixas de e-mail** (04/11: e-mails da missão funcionando com a caixa do piloto) |
| Teams | Política `Omni-Reunioes` só para o usuário do piloto (conferido em 05/11: o Graph acha a reunião pelo link). **Transcrições bloqueadas no tenant** (`403 GraphAccessToTranscriptsDisabled`): ligar pelo passo a passo em `teams-transcricoes.md` |
| SharePoint comercial | Os arquivos ficam no site **Arquivos Filtrovali** (`https://<tenant>.sharepoint.com/sites/arquivosfiltrovali`, biblioteca "Documentos" `<driveId>`, pasta "6 - DEPARTAMENTO COMERCIAL"). `Read` concedido em 04/11 e conferido. **Confirmado em 04/11:** o `SHAREPOINT_DRIVE_ID` do Prisma é essa biblioteca. O `Read` no TimeComercial (biblioteca vazia) pode ser removido |
| Próximos passos | Restringir às pastas do Prisma: `sharepoint-restringir-pastas.md` · remover o TimeComercial: `sharepoint-remover-timecomercial.md` · criar o site dos anexos: `sharepoint-site-anexos.md` · LGPD: `../producao/lgpd-ropa-dpa.md` |
| Alcance | **Restrito em 04/11/2026** (`sharepoint-restringir-pastas.md`): `Read` só na pasta "6 - DEPARTAMENTO COMERCIAL / A Propostas" (permissão `ListItems.SelectedOperations.Selected`) e o `Read` no site inteiro foi removido. Conferido: Departamento Pessoal e as outras pastas do comercial dão 404; a raiz da biblioteca aparece vazia; as pastas das missões abrem e baixam no Omni |
| Site dos anexos do Omni/Foco | `https://<tenant>.sharepoint.com/sites/OmniAnexos`, biblioteca Documentos, `Write` só nele (04/11/2026; conferido: cria e apaga arquivo; escrita no site comercial recusada) |

**O que o Omni já faz** (código pronto; validado com respostas sintéticas do Graph e com o sandbox do Prisma, **ainda não com o SharePoint real**): aba **Arquivos** da missão com as pastas comerciais pelos vínculos do Prisma (contrato 1.66.0, `crm-filtrovali/docs/prisma-omni.md`), navegação e download pelo servidor, conferindo a permissão de cada pessoa no Omni e que o arquivo está dentro da pasta vinculada. A integração SharePoint **não está concluída** até essa validação real.

## O que o Omni vai fazer com cada permissão

| Recurso | Para quê | Permissão | Como fica limitada |
|---|---|---|---|
| E-mails | Ler e-mails das missões em qualquer caixa autorizada (INSTRUCOES §6.9) | Exchange **Application Mail.Read** | Exchange RBAC para aplicativos → só as caixas do grupo `Omni - Caixas` |
| Envio | Enviar e-mail com a assinatura de quem envia | Exchange **Application Mail.Send** | Mesmo grupo. O Omni só deixa cada pessoa enviar da **própria** caixa (conferido no servidor e auditado) |
| Agenda | Achar as reuniões do Teams ligadas à conversa | Exchange **Application Calendars.Read** | Mesmo grupo |
| Reuniões | Gravações e transcrições do Teams | Graph `OnlineMeetings.Read.All`, `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All` (aplicativo) | Política de acesso do Teams → só os usuários escolhidos |
| SharePoint | Pastas de clientes/missões e anexos | Graph `Sites.Selected` (aplicativo) | Concessão **site a site**: leitura nos sites de clientes; escrita no site dedicado aos anexos do Omni |
| Pessoas | Nome, cargo e telefone dos colaboradores | Graph `User.Read.All` (aplicativo) | Só leitura do diretório |
| Quem entra no Omni | Lista de Pessoas a partir de "Usuários e grupos" do app **Omni** (login), com "Atribuição necessária"; quem sai é desativado (job `entra-pessoas`, migration 0049) | Graph `Application.Read.All` e `GroupMember.Read.All` (aplicativo), com o `User.Read.All` acima | Só leitura; o Omni lê só as atribuições do app de login (`ENTRA_CLIENT_ID`) e os membros dos grupos atribuídos a ele |

> **Importante:** `Mail.Read`, `Mail.Send` e `Calendars.Read` **não** são marcadas no Entra. Se forem consentidas lá, valem para **todas** as caixas do tenant. Elas são dadas só pelo Exchange (passo 4), já limitadas ao grupo.

## Passo 1 — Registro do app

1. https://entra.microsoft.com → **Identidade → Aplicativos → Registros de aplicativo → Novo registro**.
2. Nome `Omni – Integrações`; **somente este diretório**; **sem** URI de redirecionamento (o app não faz login de pessoas).
3. Anote o **ID do aplicativo (cliente)** e o **ID do objeto** do aplicativo empresarial correspondente (Aplicativos empresariais → Omni – Integrações → Visão geral).

## Passo 2 — Credencial (certificado)

```bash
openssl req -x509 -newkey rsa:3072 -sha256 -days 730 -nodes \
  -keyout omni-graph.key -out omni-graph.crt -subj "/CN=Omni Integracoes Filtrovali"
openssl x509 -in omni-graph.crt -noout -fingerprint -sha256 | sed 's/.*=//; s/://g'
```

- Envie só o `omni-graph.crt` em **Certificados e segredos → Certificados**.
- O `omni-graph.key` fica fora do repositório (desenvolvimento: `~/.secrets/`; produção: na VPS, fora da imagem).
- Para começar no desenvolvimento pode ser um segredo do cliente (6 meses), mas a produção usa o certificado.

## Passo 3 — Permissões no Entra (só as que não são do Exchange)

**Permissões de API → Adicionar → Microsoft Graph → Permissões de aplicativo:**

- `User.Read.All`
- `Application.Read.All` e `GroupMember.Read.All` (lista de Pessoas pelo app "Omni", 11/11/2026)
- `Sites.Selected`
- `OnlineMeetings.Read.All`
- `OnlineMeetingTranscript.Read.All`
- `OnlineMeetingRecording.Read.All`

Depois: **Conceder consentimento do administrador para Filtrovali.**
Não adicione `Mail.*` nem `Calendars.*` aqui.

## Passo 4 — Caixas de e-mail (Exchange RBAC para aplicativos)

1. No [Centro de Administração do Exchange](https://admin.exchange.microsoft.com), abra **Destinatários → Grupos → Segurança habilitada para e-mail → Adicionar um grupo**. Crie o grupo `Omni - Caixas` e coloque nele as caixas que o Omni pode ler (as pessoas e as caixas de setor envolvidas em missões). Adicione cada caixa como **membro direto**: ser proprietário do grupo ou membro de um grupo aninhado não inclui a caixa no escopo.
2. No PowerShell do Exchange Online:

```powershell
Connect-ExchangeOnline

# Representa o app no Exchange (AppId = ID do aplicativo; ObjectId = ID do objeto do aplicativo empresarial)
New-ServicePrincipal -AppId <ID_DO_APLICATIVO> -ObjectId <ID_DO_OBJETO> -DisplayName "Omni – Integrações"

# Escopo: só os membros diretos do grupo. Execute este bloco inteiro.
& {
    $grupoOmni = Get-DistributionGroup -Identity "Omni - Caixas" -ErrorAction Stop
    $dnOmni = [string]$grupoOmni.DistinguishedName
    if ([string]::IsNullOrWhiteSpace($dnOmni)) {
        throw "O grupo Omni - Caixas não retornou DistinguishedName; escopo não foi criado."
    }
    New-ManagementScope -Name "Omni - Caixas" -RecipientRestrictionFilter "MemberOfGroup -eq '$dnOmni'" -ErrorAction Stop
}

New-ManagementRoleAssignment -App <ID_DO_APLICATIVO> -Role "Application Mail.Read"      -CustomResourceScope "Omni - Caixas"
New-ManagementRoleAssignment -App <ID_DO_APLICATIVO> -Role "Application Mail.Send"      -CustomResourceScope "Omni - Caixas"
New-ManagementRoleAssignment -App <ID_DO_APLICATIVO> -Role "Application Calendars.Read" -CustomResourceScope "Omni - Caixas"

# Conferência: deve dar "InScope = True" para uma caixa do grupo e False para outra fora dele
Test-ServicePrincipalAuthorization -Identity <ID_DO_APLICATIVO> -Resource <email.de.uma.caixa@filtrovali.com.br>
```

> O cache das permissões usadas pela aplicação pode levar de 30 minutos a 2 horas para atualizar. **`Test-ServicePrincipalAuthorization` ignora esse cache de autorização**; se retornar `InScope = False`, confira os membros e o filtro antes de atribuir o resultado à espera. Veja a [documentação do RBAC para aplicativos](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac#limitations).

### Se o teste retornar `InScope = False`

Confira o filtro salvo e os membros diretos:

```powershell
Get-ManagementScope -Identity "Omni - Caixas" -ErrorAction Stop |
    Format-List Name, RecipientRoot, RecipientFilter
Get-DistributionGroupMember -Identity "Omni - Caixas" -ResultSize Unlimited |
    Format-Table DisplayName, PrimarySmtpAddress, RecipientTypeDetails -AutoSize
```

A caixa testada deve aparecer entre os membros. O filtro deve conter `MemberOfGroup -eq '<DistinguishedName completo do grupo>'`. Se aparecer **`MemberOfGroup -eq ''`**, o escopo foi criado com o identificador do grupo vazio. Corrija o escopo existente com o bloco completo abaixo:

```powershell
& {
    $grupoOmni = Get-DistributionGroup -Identity "Omni - Caixas" -ErrorAction Stop
    $dnOmni = [string]$grupoOmni.DistinguishedName
    if ([string]::IsNullOrWhiteSpace($dnOmni)) {
        throw "O grupo Omni - Caixas não retornou DistinguishedName; escopo não foi alterado."
    }
    Set-ManagementScope -Identity "Omni - Caixas" -RecipientRestrictionFilter "MemberOfGroup -eq '$dnOmni'" -ErrorAction Stop
    Get-ManagementScope -Identity "Omni - Caixas" -ErrorAction Stop |
        Format-List Name, RecipientRoot, RecipientFilter
}
```

As atribuições existentes passam a usar o filtro corrigido; não repita `New-ServicePrincipal` nem `New-ManagementRoleAssignment`. Repita o teste de autorização para uma caixa do grupo e outra fora dele.

## Passo 4b — Marcar como lido e e-mail novo na hora (24/11/2026)

**Marcar como lido/não lido** precisa da função **Application Mail.ReadWrite**, no mesmo escopo das caixas
("Omni - Caixas"). Ela não é marcada no Entra (valeria para o tenant inteiro): é dada pelo Exchange, como as do passo 4.

1. Quem administra o Exchange abre o PowerShell (no Windows: PowerShell; em qualquer sistema: `pwsh`) e conecta:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # só na primeira vez
Connect-ExchangeOnline                                       # entra com a conta de administrador
```

2. Dá a função ao app "Omni – Integrações", só nas caixas do grupo:

```powershell
New-ManagementRoleAssignment -App <GUID> -Role "Application Mail.ReadWrite" -CustomResourceScope "Omni - Caixas"
```

3. Confere (deve listar `Application Mail.ReadWrite` com `InScope = True` para uma caixa do grupo e `False` para outra fora dele):

```powershell
Test-ServicePrincipalAuthorization -Identity <GUID> -Resource email.de.uma.caixa@filtrovali.com.br | Format-Table RoleName, InScope
```

A permissão leva de 30 minutos a 2 horas para valer. Até lá, abrir um e-mail no Omni não o marca como lido e o botão
"Marcar como não lido" avisa que falta a permissão. A `Application Mail.Read` pode ficar (a ReadWrite já inclui a leitura).
**Não** é preciso mexer no Entra nem dar consentimento de administrador.

**E-mail novo na hora** usa os avisos do Graph (assinaturas), com a leitura que o app já tem (`Application Mail.Read`).
Não precisa de permissão nova; precisa de o Omni ser acessível pela internet em HTTPS (`APP_ORIGIN`):

1. No `.env.production`: `EMAIL_AVISO_IMEDIATO=ligado` e reinicie o worker (`up -d worker`).
2. A cada 30 minutos o worker cria ou renova uma assinatura por caixa ativa (job `graph-avisos`); o Graph confere o
   endereço `https://omni.filtrovali.com.br/api/graph/avisos` na hora de criar.
3. Conferir: `SQL "SELECT b.email, s.expires_at, s.last_notified_at FROM graph_subscriptions s JOIN mail_mailboxes b ON b.id = s.mailbox_id"`
   — uma linha por caixa; `last_notified_at` muda quando chega um e-mail. Se uma caixa não aparecer, o log do worker
   mostra `[graph-avisos] não assinou uma caixa: <status>` (403: a caixa não está no grupo; a leitura de 5 em 5 minutos
   continua valendo para ela).

Para desligar: `EMAIL_AVISO_IMEDIATO=desligado` — o worker apaga as assinaturas ao subir.

## Passo 5 — Reuniões do Teams

Use Windows PowerShell 5.1 ou PowerShell 7.2 ou superior. Antes da primeira conexão, instale o módulo `MicrosoftTeams` para o seu usuário:

```powershell
Install-Module -Name MicrosoftTeams -Repository PSGallery -Scope CurrentUser -ErrorAction Stop
```

Se a instalação solicitar o provedor NuGet ou a confirmação do repositório PSGallery, confirme para continuar. Em cada nova sessão, importe o módulo e conecte com uma conta de **Administrador do Teams** (ou Administrador Global), no mesmo tenant do Omni. Veja a [instalação oficial do módulo](https://learn.microsoft.com/en-us/microsoftteams/teams-powershell-install).

```powershell
Import-Module MicrosoftTeams -ErrorAction Stop
Connect-MicrosoftTeams -ErrorAction Stop
New-CsApplicationAccessPolicy -Identity "Omni-Reunioes" -AppIds "<ID_DO_APLICATIVO>" -Description "Omni lê reuniões, gravações e transcrições"
# Para cada pessoa cujas reuniões o Omni pode ler (ou use -Global se a diretoria decidir que vale para todos):
Grant-CsApplicationAccessPolicy -PolicyName "Omni-Reunioes" -Identity <email.da.pessoa@filtrovali.com.br>
```

Confirme também que a **transcrição** está habilitada nas políticas de reunião do Teams para essas pessoas e que o **acesso do Graph às transcrições** está ligado no tenant (desligado por padrão desde julho de 2026): `teams-transcricoes.md`.

## Passo 6 — SharePoint (site a site)

São dois usos, com concessões diferentes:

| Uso | Site | Concessão | Quem organiza as pastas |
|---|---|---|---|
| **Documentos comerciais** (pastas de oportunidades e missões) | `https://<tenant>.sharepoint.com/sites/TimeComercial` — a biblioteca é a do `SHAREPOINT_DRIVE_ID` configurado no Prisma | **Read** | **O Prisma** cria e vincula; o Omni só lê, pelos ids que o Prisma informa (`driveId` + `folderId`), nunca pelo nome ou caminho |
| **Anexos próprios do Omni/Foco** (anexos das conversas e das tarefas migradas do Foco) | Site dedicado, a criar (usar o endereço real quando existir) | **Write**, só nele | O Omni |

A leitura comercial já está implementada; os anexos próprios ficam para a migração do Foco (Fase 3) e para as conversas (Fases 4 e 7).

Com o PnP PowerShell (ou pelo Graph Explorer, `POST /sites/{id}/permissions`).

Use **PowerShell 7.4 ou superior** (`pwsh`) para este passo. O PnP atual não é compatível com Windows PowerShell 5.1. Confira a versão da sessão:

```powershell
$PSVersionTable.PSVersion
```

Se precisar instalar o PowerShell 7 no Windows:

```powershell
winget install --id Microsoft.PowerShell --source winget
```

Depois da instalação, abra **PowerShell 7** pelo menu Iniciar e execute os comandos seguintes nessa nova sessão. Referências: [instalação do PnP](https://pnp.github.io/powershell/articles/installation.html) e [instalação do PowerShell no Windows](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows).

> Desde setembro de 2024 o PnP **não tem mais um app pronto** para o login interativo: é preciso registrar um app do PnP no tenant uma vez (o comando abaixo cria e pede o consentimento; use uma conta de administrador). Esse app é só da ferramenta, não do Omni.

O domínio `<tenant>.onmicrosoft.com` foi confirmado no `DistinguishedName` do grupo do Exchange. O registro abaixo já abre o login interativo por padrão: **não acrescente `-Interactive` a `Register-PnPEntraIDAppForInteractiveLogin`**. A permissão delegada do Microsoft Graph `Sites.FullControl.All` no app administrativo PnP é exigida pelo comando que concede acesso aos sites; o app **Omni – Integrações** continua com `Sites.Selected`. Veja as referências de [registro do app PnP](https://pnp.github.io/powershell/cmdlets/Register-PnPEntraIDAppForInteractiveLogin.html) e [concessão por site](https://pnp.github.io/powershell/cmdlets/Grant-PnPEntraIDAppSitePermission.html).

```powershell
Install-Module -Name PnP.PowerShell -Repository PSGallery -Scope CurrentUser -ErrorAction Stop
Import-Module PnP.PowerShell -ErrorAction Stop
Get-Command Register-PnPEntraIDAppForInteractiveLogin -ErrorAction Stop

Register-PnPEntraIDAppForInteractiveLogin `
    -ApplicationName "PnP PowerShell – Filtrovali" `
    -Tenant "<tenant>.onmicrosoft.com" `
    -GraphDelegatePermissions "Sites.FullControl.All" `
    -SharePointDelegatePermissions "AllSites.FullControl"
```

Anote o **ClientId do app PnP** retornado pelo registro. Os valores de URL abaixo se referem a **sites do SharePoint** que reúnem as bibliotecas e pastas de documentos:

| Valor a substituir | Qual endereço usar | Exemplo ilustrativo |
|---|---|---|
| `<URL_REAL_DO_SITE_SHAREPOINT>` | Um site existente ao qual a conta administrativa tenha acesso, para abrir a conexão PnP | `https://SEU-DOMINIO.sharepoint.com/sites/Clientes` |
| `<URL_DO_SITE_DE_CLIENTES>` | O site que já contém os documentos dos clientes e missões que o Omni poderá ler. O site pode ter outro nome; repita a concessão de leitura para cada site necessário | **Na Filtrovali:** `https://<tenant>.sharepoint.com/sites/TimeComercial` (confirmado em 03/11/2026) |
| `<URL_DO_SITE_DO_OMNI>` | Um site dedicado aos anexos gravados pelo Omni | `https://SEU-DOMINIO.sharepoint.com/sites/Omni` |

Para descobrir os endereços reais, abra **Microsoft 365 Admin → Centros de administração → SharePoint → Sites → Sites ativos** e copie o endereço na coluna **URL** do site escolhido. Use a URL do site exibida nessa lista; links de compartilhamento de arquivos, pastas, bibliotecas ou páginas como `AllItems.aspx` não são o valor deste parâmetro. Veja como [gerenciar os sites ativos](https://learn.microsoft.com/en-us/sharepoint/get-started-new-admin-center).

**Alcance da concessão:** estes comandos com `Sites.Selected` concedem acesso ao **site inteiro**, não apenas a uma biblioteca ou pasta. Para manter leitura nos documentos dos clientes e escrita nos anexos do Omni, use um site separado para os anexos. Conceder `Write` ao mesmo site dos clientes permite escrita nesse site. Restringir apenas a uma biblioteca exige outra configuração de permissões, descrita na [visão geral das permissões Selected](https://learn.microsoft.com/en-us/graph/permissions-selected-overview).

Substitua os valores entre `<...>` e continue na mesma sessão. O `-Interactive` é usado aqui no `Connect-PnPOnline`:

```powershell
Connect-PnPOnline -Url "<URL_REAL_DO_SITE_SHAREPOINT>" -Interactive -ClientId "<CLIENT_ID_DO_APP_DO_PNP>" -ErrorAction Stop
# Sites de clientes/missões: só leitura
Grant-PnPEntraIDAppSitePermission -AppId "<ID_DO_APLICATIVO_OMNI_INTEGRACOES>" -DisplayName "Omni – Integrações" -Site "<URL_DO_SITE_DE_CLIENTES>" -Permissions Read
# Site dedicado aos anexos do Omni (tarefas migradas do Foco e conversa): escrita
Grant-PnPEntraIDAppSitePermission -AppId "<ID_DO_APLICATIVO_OMNI_INTEGRACOES>" -DisplayName "Omni – Integrações" -Site "<URL_DO_SITE_DO_OMNI>" -Permissions Write
```

Crie antes um **site separado**, como **"Omni – Anexos"**, para os anexos. Dentro dele, use uma biblioteca de documentos para armazenar os arquivos.

Para o site comercial da Filtrovali, o comando de leitura fica assim (e a conferência deve listar o `Omni – Integrações` com `Read`):

```powershell
Grant-PnPEntraIDAppSitePermission -AppId "<GUID>" -DisplayName "Omni – Integrações" -Site "https://<tenant>.sharepoint.com/sites/TimeComercial" -Permissions Read
Get-PnPEntraIDAppSitePermission -Site "https://<tenant>.sharepoint.com/sites/TimeComercial"
```

### Se a concessão der `accessDenied` ou `Invalid hostname`

- **`accessDenied`** (acontece igual para qualquer administrador): o token do **app do PnP** não tem a permissão delegada do Graph `Sites.FullControl.All`. Comum quando o app do PnP foi registrado antes, sem `-GraphDelegatePermissions`. Corrija no Entra: **Registros de aplicativo → PnP PowerShell – Filtrovali → Permissões de API → Adicionar → Microsoft Graph → Permissões delegadas → `Sites.FullControl.All` → Conceder consentimento do administrador**. Depois, na sessão: `Disconnect-PnPOnline`, conecte de novo com `-ClientId` desse app e confira com `(Get-PnPAccessToken -ResourceTypeName Graph -Decoded).Payload.scp` (deve conter `Sites.FullControl.All`) antes de repetir a concessão.
- **Alternativa sem o PnP** (Graph Explorer, `https://developer.microsoft.com/graph/graph-explorer`, entrando com um administrador e consentindo `Sites.FullControl.All`): `POST https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com,<GUID>,<GUID>/permissions` com o corpo `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<GUID>","displayName":"Omni – Integrações"}}]}`.
- **`Invalid hostname for this tenancy`**: o `-Site` precisa ser um site do SharePoint do tenant (`https://<tenant>.sharepoint.com/sites/...`). `https://omni.filtrovali.com.br` é o endereço do próprio Omni, não um site do SharePoint. A concessão de escrita só é feita quando o site dos anexos existir.

## Passo 7 — Ligar no Omni (desenvolvimento)

No `.env` da raiz:

```
GRAPH_TENANT_ID=<ID do diretório (o mesmo do login)>
GRAPH_CLIENT_ID=<ID do aplicativo Omni – Integrações>
GRAPH_PRIVATE_KEY_PATH=/home/<você>/.secrets/omni-graph.key
GRAPH_CERT_SHA256_THUMBPRINT=<impressão SHA-256 do certificado>
```

## Antes de ligar em produção (LGPD)

- A diretoria aprova e **comunica por escrito** ao time que e-mails ligados a missões ficam visíveis à gestão no Omni (INSTRUCOES §13).
- O encarregado (`privacidade@filtrovali.com.br`) inclui o Omni e o Microsoft Graph na ROPA.
- Em tempo real (webhooks/subscriptions do Graph), a Microsoft precisa alcançar uma URL pública HTTPS: só funciona com o Omni publicado (`omni.filtrovali.com.br`). No desenvolvimento o Omni usa leitura incremental (delta) a cada poucos minutos.

## O que falta para validar a Fase 4 (03/11/2026)

1. ~~ID do aplicativo e do diretório~~ ✅ no `.env`. **Carregar o certificado `omni-graph.crt` no registro** (está em `~/.secrets/`).
2. ~~Caixas do piloto~~ ✅ (uma caixa).
3. ~~Site comercial~~ ✅ `TimeComercial`; conferir a concessão `Read` (passo 6).
4. ~~Política do Teams~~ ✅ só para o piloto.
5. Criar o site dos anexos do Omni/Foco e dar `Write` só nele (quando a migração do Foco começar).
6. Pastas reais no Prisma: o ambiente `production` da API do Prisma ainda está desligado e o `sandbox` não tem registros; para validar ponta a ponta, o Prisma precisa de fixtures com `sharepointFolders` no sandbox (ou da homologação de produção).
