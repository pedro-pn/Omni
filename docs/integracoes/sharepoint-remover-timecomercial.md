# SharePoint: remover o acesso do Omni ao site TimeComercial

> Escrito em 04/11/2026. Pendência nº 8 (limpeza, opcional).
> Quem faz: **administrador do site "Time Comercial"** (a mesma conta que deu o `Read` em 04/11).

## Por quê

Em 04/11 o app **Omni – Integrações** recebeu `Read` no site `https://<tenant>.sharepoint.com/sites/TimeComercial`, mas a biblioteca dele está vazia: as pastas do Prisma ficam no site **Arquivos Filtrovali**. Acesso que não é usado deve ser retirado.

## Valores

| Item | Valor |
|---|---|
| App Omni – Integrações | `<GUID>` |
| Site Time Comercial (`siteId`) | `<tenant>.sharepoint.com,<GUID>,<GUID>` |

## Opção A — Graph Explorer (o caminho que funcionou em 04/11)

1. Abra https://developer.microsoft.com/graph/graph-explorer e entre com a conta administradora do site.
2. Em **Modificar permissões**, confirme `Sites.FullControl.All` consentido e clique em **Reload**.
3. Liste as concessões do site:

```
GET https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com,<GUID>,<GUID>/permissions
```

4. Na resposta, ache o item com `"application": { "id": "<GUID>" }` (em `grantedToIdentitiesV2`) e copie o `"id"` desse item.
5. Remova:

```
DELETE https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com,<GUID>,<GUID>/permissions/{id}
```

Resposta esperada: **`204 No Content`**.

## Opção B — PnP PowerShell

Na sessão do PowerShell 7 conectada com o app do PnP (ver `m365-registro.md`, passo 6):

```powershell
Get-PnPEntraIDAppSitePermission -Site "https://<tenant>.sharepoint.com/sites/TimeComercial"
# Copie o PermissionId da linha do "Omni – Integrações" e:
Revoke-PnPEntraIDAppSitePermission -Site "https://<tenant>.sharepoint.com/sites/TimeComercial" -PermissionId "<PermissionId>" -Force
```

## Conferência (eu faço)

Me avise depois de remover. O esperado, pelo app do Omni:

| Teste | Esperado |
|---|---|
| Biblioteca do Time Comercial | `403` |
| Biblioteca do Arquivos Filtrovali (pasta da missão 5851) | Continua abrindo |
