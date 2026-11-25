# SharePoint: restringir o Omni às pastas que o Prisma usa

> Escrito em 04/11/2026. Pendência nº 7 (antes da produção). **Feito em 04/11/2026:** concessão em "A Propostas" (alternativa de uma pasta só, `201`), `Read` do site removido (`204`) e conferência do passo 5 aprovada.
> Quem faz: **administrador do site "Arquivos Filtrovali"** (o mesmo que deu o `Read` em 04/11) e **administrador de aplicativos do Entra**.

## Por quê

Hoje o app **Omni – Integrações** tem `Read` no **site inteiro** `https://<tenant>.sharepoint.com/sites/arquivosfiltrovali`, que guarda também Departamento Pessoal, Colaboradores, Seguros e outros departamentos. Para quem usa o Omni isso não aparece (o Omni só abre as pastas que o Prisma vincula), mas a **credencial do app** consegue ler tudo. O objetivo é que ela leia só as pastas onde o Prisma cria as pastas das oportunidades e missões.

## O que muda

| Antes | Depois |
|---|---|
| `Sites.Selected` + `Read` no site inteiro | `ListItems.SelectedOperations.Selected` + `Read` só nas 6 pastas de situação do Prisma |

O código do Omni **não muda**: ele já navega só por ids a partir da pasta vinculada.

## Valores reais (conferidos em 04/11/2026)

| Item | Valor |
|---|---|
| App Omni – Integrações | `<GUID>` |
| Site Arquivos Filtrovali (`siteId`) | `<tenant>.sharepoint.com,<GUID>,<GUID>` |
| Biblioteca "Documentos" (`listId`) | `<GUID>` |
| Biblioteca "Documentos" (`driveId`, = `SHAREPOINT_DRIVE_ID` do Prisma) | `<driveId>` |

As pastas do Prisma ficam em **"6 - DEPARTAMENTO COMERCIAL / A Propostas"**, separadas por situação:

| Pasta | `listItemId` | `driveItemId` |
|---|---|---|
| 1 Obras em cotação | 132373 | `01OSVEJSVHLSQ7YQBPCNNZOEXFLIOWYXXA` |
| 2 Obras em andamento | 132378 | `01OSVEJSSXIFVYLCDGQBPIVS72RIJVVOQE` |
| 3 Obras concluidas | 132385 | `01OSVEJSRKJHAQFPPKJ5L3RS2GFXFQ3U5K` |
| 4 Obras Perdidas | 132391 | `01OSVEJSWAVZRIOX325FPKUMXTDUCT2N66` |
| 5 Propostas Fechadas | 132397 | `01OSVEJSR3RIZP2SMVPRIZ7EBCRFKDSOPB` |
| 6 Obras descartadas | 745417 | `01OSVEJST74EFQUFYUQBAI45U7U6RZG6Q4` |

As pastas vinculadas no sandbox (missões 5849, 5851 e 5854) estão todas em "2 Obras em andamento".

## ⚠️ Antes de começar: herança de permissões

Pela documentação da Microsoft, **dar permissão a um aplicativo numa pasta quebra a herança de permissões dessa pasta**. As permissões das pessoas que existem no momento são copiadas, mas, depois disso, **mudanças feitas no site ou em "A Propostas" não chegam mais a essas 6 pastas** — quem administra o SharePoint passa a cuidar delas separadamente.

Se isso for um problema, a alternativa é conceder só em **"A Propostas"** (`listItemId` 131934, uma quebra de herança só). O app passaria a ler também o resto de "A Propostas" (BDI, banco de dados, procedimentos), mas continuaria sem acesso a RH, seguros e aos outros departamentos. Escolha uma das duas e siga os passos com os ids correspondentes.

## Passo 0 — Confirmar as pastas com o Prisma

No Prisma, confira as variáveis do conector do SharePoint (`SHAREPOINT_ACTIVE_PARENT_FOLDER_ID`, `SHAREPOINT_WON_PARENT_FOLDER_ID` e as de arquivo/perdidas). Os valores devem estar entre os `driveItemId` da tabela acima (ou ser subpastas delas). Se alguma variável apontar para uma pasta fora da lista, inclua essa pasta nos passos 2 e 4.

## Passo 1 — Dar ao app a permissão granular (Entra)

1. https://entra.microsoft.com → **Registros de aplicativo → Omni – Integrações → Permissões de API**.
2. **Adicionar uma permissão → Microsoft Graph → Permissões de aplicativo** → marque **`ListItems.SelectedOperations.Selected`** → **Adicionar**.
3. **Conceder consentimento do administrador para Filtrovali**. A coluna "Status" deve ficar verde.
4. **Não remova `Sites.Selected`**: ele será usado no site dos anexos do Omni (escrita).

Sozinha, essa permissão não dá acesso a nada — só passa a valer nas pastas do passo 2.

## Passo 2 — Conceder `Read` nas 6 pastas (Graph Explorer)

1. Abra https://developer.microsoft.com/graph/graph-explorer e entre com a conta **administradora do site Arquivos Filtrovali**.
2. Em **Modificar permissões**, confirme `Sites.FullControl.All` consentido e clique em **Reload** (o token precisa ser novo; confira na aba **Access token** que `scp` contém `Sites.FullControl.All`).
3. **Teste de acesso da conta** (antes de conceder): faça um `GET` na pasta. Se der `404 itemNotFound`, a conta do Graph Explorer não enxerga essa pasta no SharePoint (pasta com permissões próprias): torne a conta administradora do site ou dê acesso a ela na pasta e repita.

```
GET https://graph.microsoft.com/v1.0/drives/<driveId>/items/{driveItemId}
```

4. Para **cada** pasta da tabela, faça o `POST` pela pasta da biblioteca (rota `driveItem`, a documentada para pastas), trocando só o `{driveItemId}`:

```
POST https://graph.microsoft.com/v1.0/drives/<driveId>/items/{driveItemId}/permissions
```

Corpo (essa rota só aceita `grantedToV2`):

```json
{
  "grantedToV2": {
    "application": {
      "id": "<GUID>"
    }
  },
  "roles": ["read"]
}
```

Resposta esperada: **`201 Created`**. Anote o `id` de cada resposta (serve para desfazer).

> Se escolheu a alternativa de conceder só em **"A Propostas"**, use `{driveItemId}` = `01OSVEJSRNJ5OMDM335FN3VX5UOJDETPDX`.
>
> A rota pela lista (`…/sites/{siteId}/lists/{listId}/items/{listItemId}/permissions`) respondeu `404 itemNotFound` em 04/11/2026 para "A Propostas" (`listItemId` 131934), embora o item exista; use a rota `driveItem` acima.

## Passo 3 — Me avise para conferir antes de tirar o acesso ao site

Com as pastas concedidas e o site ainda liberado, eu confiro que o token do Omni já traz `ListItems.SelectedOperations.Selected`. Não pule para o passo 4 sem essa conferência.

## Passo 4 — Remover o `Read` do site inteiro

No Graph Explorer, com a mesma conta:

1. Liste as concessões do site:

```
GET https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com,<GUID>,<GUID>/permissions
```

2. Ache o item cujo `grantedToIdentitiesV2[0].application.id` é `<GUID>` e copie o `id` dele.
3. Remova:

```
DELETE https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com,<GUID>,<GUID>/permissions/{id}
```

Resposta esperada: **`204 No Content`**.

## Passo 5 — Conferência (eu faço)

Depois de reiniciar o `npm run dev` e o `npm run dev:worker` (o token do Omni é guardado por até ~1 hora):

| Teste | Esperado |
|---|---|
| Aba Arquivos da missão 5851 (pasta e subpastas) | Abre e baixa |
| Raiz da biblioteca "Documentos" | `403` |
| "3 - DEPARTAMENTO PESSOAL" | `403` |
| Outra pasta de "A Propostas" fora das 6 (ex.: "Banco de dados") | `403` (se escolheu as 6 pastas) |

## Depois

- **Pasta nova de situação no Prisma** (ex.: o Prisma passa a usar "7 …"): repita o passo 2 para ela; até lá o Omni mostra "O Omni ainda não tem permissão de leitura neste site do SharePoint" nessas pastas.
- **Desfazer**: `DELETE https://graph.microsoft.com/v1.0/drives/<driveId>/items/{driveItemId}/permissions/{id}` em cada pasta e, se precisar voltar ao modo anterior, conceder de novo o `Read` no site (`POST …/sites/{siteId}/permissions` com `"roles": ["read"]` e `grantedToIdentities`).

Referências: [visão geral das permissões Selected](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) e [criar permissão em driveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-post-permissions).
