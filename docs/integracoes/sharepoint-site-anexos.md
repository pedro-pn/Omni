# SharePoint: criar o site dos anexos do Omni

> Escrito em 04/11/2026. Pendência nº 9 — necessário antes da migração dos anexos do Foco (Fase 3) e dos anexos das conversas (Fases 4 e 7).
> Quem faz: **administrador do SharePoint** (ou Global) e, para a concessão, um administrador do novo site.
>
> **Feito em 04/11/2026:** site `https://<tenant>.sharepoint.com/sites/OmniAnexos` (id `<tenant>.sharepoint.com,<GUID>,<GUID>`), biblioteca **Documentos** (`<driveId>`, no `.env` como `GRAPH_ANEXOS_DRIVE_ID`). Conferido pelo app: cria, lê e apaga um arquivo de teste; escrita em "A Propostas" é recusada (403).

## Para que serve

O Omni guarda aqui os arquivos **dele**: anexos das tarefas migradas do Foco e anexos enviados nas conversas. É separado dos documentos comerciais (site Arquivos Filtrovali, só leitura, organizado pelo Prisma) porque o app precisa de **escrita** e a concessão do `Sites.Selected` vale para o site inteiro.

Regras do site:
- Ninguém navega nele pelo SharePoint no dia a dia: quem decide quem vê cada anexo é o Omni (permissão no banco).
- Só administradores como membros; sem compartilhamento externo.

## Passo 1 — Criar o site

1. Abra o **Centro de administração do SharePoint** (https://<tenant>-admin.sharepoint.com) → **Sites → Sites ativos → Criar**.
2. Escolha **Outras opções → Site de equipe sem grupo do Microsoft 365** (evita criar grupo, caixa e Teams que não serão usados).
3. Preencha:
   - **Nome:** `Omni Anexos`
   - **Endereço:** `https://<tenant>.sharepoint.com/sites/omni-anexos` (se preferir outro, me passe o endereço real)
   - **Proprietário principal:** a conta administradora (de preferência uma conta de serviço ou de TI, não pessoal)
   - **Idioma:** Português (Brasil) — não dá para mudar depois
4. **Concluir.**

## Passo 2 — Ajustes de segurança do site

No Centro de administração do SharePoint → **Sites ativos → Omni Anexos**:

1. **Compartilhamento externo:** **Somente pessoas da sua organização** (ou **Nenhum**).
2. **Membros:** deixe só os administradores. Não adicione grupos de usuários.
3. No site (https://<tenant>.sharepoint.com/sites/omni-anexos) → **Configurações → Conteúdos do site → Documentos → Configurações da biblioteca → Configurações de controle de versão**: mantenha o **controle de versão ligado** (o padrão do SharePoint é suficiente).
4. Opcional: crie uma biblioteca **"Anexos"** (Novo → Biblioteca de documentos). Se não criar, o Omni usa a "Documentos".

## Passo 3 — Conceder `Write` ao Omni (Graph Explorer)

1. Abra https://developer.microsoft.com/graph/graph-explorer e entre com a conta **administradora do novo site**.
2. Em **Modificar permissões**, confirme `Sites.FullControl.All` consentido e clique em **Reload**.
3. Pegue o id do site:

```
GET https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com:/sites/omni-anexos?$select=id,webUrl
```

4. Conceda (troque `{siteId}` pelo `id` da resposta anterior):

```
POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
```

Corpo:

```json
{
  "roles": ["write"],
  "grantedToIdentities": [{
    "application": {
      "id": "<GUID>",
      "displayName": "Omni – Integrações"
    }
  }]
}
```

Resposta esperada: **`201 Created`**.

> Use **`write`**, não `owner` nem `fullcontrol`: o Omni só cria, lê e substitui arquivos.
> **Não** conceda `Write` no site Arquivos Filtrovali nem em outro site: escrita só aqui.

## Passo 4 — Me passar o endereço

Me envie o endereço real do site (e o nome da biblioteca, se criou "Anexos"). Eu:
1. confiro pelo app do Omni que ele **lê, cria e apaga** um arquivo de teste nesse site (e só nele);
2. registro o endereço no `.env` e na documentação;
3. confirmo que o site comercial continua só com leitura.

## Gravações das ligações (11/11/2026)

O Omni guarda aqui as gravações das ligações em M4A **cifrado** (`.m4a.cifrado`, uma chave por gravação, guardada no banco do Omni e protegida pela chave mestra do servidor): `Gravacoes/AAAA/MM/<id da ligação>.m4a.cifrado` na produção, `Gravacoes-staging/…` e `Gravacoes-desenvolvimento/…` fora dela (sem nome nem telefone no caminho). Quem pode ouvir é o Omni que decide (o dono e quem recebeu o compartilhamento). Os administradores do site e do Microsoft 365 alcançam os arquivos, mas sem a chave eles são ilegíveis. Ensaio de 12/11/2026: arquivo cifrado enviado, tocado pelo Omni inteiro e em trechos (206, inclusive na emenda entre blocos), conferido byte a byte; excluída a gravação, a chave sumiu do banco e o áudio passou a 404. Conferido em 11/11/2026 pelo app: envio em partes (12 MiB), leitura de um trecho (206) e exclusão definitiva (`permanentDelete`, sem lixeira). Variável: `GRAPH_ANEXOS_DRIVE_ID` (worker).

## Depois

- A migração dos anexos do Foco (Fase 3) copia os arquivos do Storage do Supabase para este site, com conferência por hash.
- Retenção: quando a política de retenção da empresa for definida, aplicar a este site (Centro de conformidade do Microsoft Purview).
