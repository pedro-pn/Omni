# ADR 0004 — WhatsApp pela Evolution (pareamento por QR code)

- **Data:** 26/10/2026 · **Revisão:** 03/11/2026 · **Situação:** aceita (decisão do Otávio, com o risco conhecido)

## Contexto
O Prisma CRM já tem uma central de Atendimento com WhatsApp: um número pela Meta (oficial) e números pareados por QR na **Evolution**, que espelha o WhatsApp Web (Baileys). A primeira versão desta ADR (26/10) restringia o Omni à Cloud API oficial. Em 03/11/2026 a diretoria decidiu usar a **Evolution com pareamento por QR code** também no Omni: liga os números que a empresa já usa sem a verificação da Meta, sem custo por conversa e com grupos.

## Decisão
- O Omni usa a **Evolution** (QR code) para os números de WhatsApp.
- **Cada número fica conectado a um sistema só** (Prisma ou Omni) enquanto os dois existirem; a unificação no Omni (Fase 10) migra os números do Prisma para o Omni, ainda pela Evolution.
- A integração fica atrás de uma interface do Omni (`WhatsApp`), para poder trocar um número para a Cloud API oficial sem mexer nas telas.

## Riscos aceitos
- **Não é oficial:** contraria os termos do WhatsApp; um número pode ser **banido** sem aviso, inclusive com o histórico do aparelho.
- **Depende do aparelho e da sessão:** desconexão do celular ou da sessão perde mensagens até reconectar; mudanças do WhatsApp podem quebrar a Evolution até ela ser atualizada.
- **Sem suporte da Meta** nem SLA.

## Travas (obrigatórias no código)
- Mensagens **internas e gerenciais nunca** saem pelo WhatsApp (teste automatizado).
- **Modo de ensaio por padrão** (`WHATSAPP_ENVIO=desligado | ensaio | real`); `real` é recusado fora da produção do Omni, como `FILTROAPP_ESCRITA`.
- Sem disparo em massa: limite de envios por número e por minuto, só para conversas que o cliente iniciou ou em andamento, e sempre por uma pessoa (a IA sugere, a pessoa envia).
- Webhook da Evolution autenticado; instância e chave só no servidor; a Evolution não fica exposta na internet além do necessário.
- Plano de contingência por número: se for banido, migrar aquele número para a Cloud API oficial (a interface acima permite).

## Consequências
- A Fase 7 deixa de depender da verificação da Meta; passa a depender do servidor da Evolution e do inventário dos números.
- **Servidor (decidido em 04/11/2026): Evolution própria do Omni**, separada da do Prisma, na mesma VPS. Motivo: a chave geral da Evolution abre todas as instâncias — com um servidor compartilhado, uma falha no Omni exporia os números de vendas do Prisma; e uma atualização ou queda não derruba os dois sistemas. Custo: cada número que passar do Prisma para o Omni precisa ser repareado por QR code (uma vez, em horário combinado).
- Durante a transição, um cliente que fala com vendas e com operação aparece em dois lugares.

## Implementação (05/11/2026)
Evolution própria do Omni em `deploy/evolution` (2.3.7 com o patch de presença do Prisma e uma trava que recusa subir sem chave forte), interface `WhatsApp` com o `EvolutionClient`, webhook autenticado, migration 0027 (números, conversas, mensagens; quem vê: responsável, membros escolhidos e diretoria) e pareamento pela Administração. Detalhes e passo a passo: `docs/integracoes/whatsapp-evolution.md`.
