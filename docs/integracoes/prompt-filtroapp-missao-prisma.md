# Prompt para o Claude Code no filtroAPP — missão do Prisma no projeto (vínculo oficial)

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`. Escrito em 03/11/2026.

---

## Contexto

O Omni (`../omni`) liga cada missão do Prisma CRM ao projeto do filtroAPP para mostrar as pastas comerciais do SharePoint que o Prisma vincula à missão. Hoje a ligação é pelo **número da missão** (= `Project.code`), com travas. Mas o Prisma tem duas numerações (`filtrovali` e `fentecx`) e não expõe qual é qual, então um número repetido fica sem vínculo.

O filtroAPP já tem o vínculo oficial em `CrmProjectMapping` (`prismaMissionId`, `projectId`, `number`, `numberScope`), mas o modelo está como `RESERVED` no catálogo e não sai na API.

## Pedido (mudança aditiva, sem escopo novo)

Em `GET /projetos`, escopo atual `projetos.read`, acrescente:

| Campo | Origem | Observação |
|---|---|---|
| `prisma` | `CrmProjectMapping` do projeto, ou `null` | Só o vínculo do ambiente de produção do Prisma |
| `prisma.missionId` | `prismaMissionId` | Identificador opaco da missão no Prisma |
| `prisma.number` | `number` | Como o Prisma numerou |
| `prisma.numberScope` | `numberScope` | `filtrovali` ou `fentecx` |

- Mudança no vínculo deve alterar o `updatedAt` do projeto (ou emitir `projeto.atualizado`), para o Omni perceber pelo incremental.
- Sem dados pessoais, sem outros campos do mapeamento.

## Entrega

1. Contrato da spec 034, OpenAPI e playground atualizados, com exemplo fictício.
2. Testes: projeto com e sem mapeamento; recorte de projeto do token; o campo não aparece para outro ambiente do Prisma.
3. Relatório com o nome final dos campos.

Depois disso, o Omni passa a usar esse vínculo (método `filtroapp`) e o número vira só a reserva.
