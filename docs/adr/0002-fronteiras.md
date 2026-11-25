# ADR 0002 — Fronteiras do Omni com os outros sistemas

- **Data:** 26/10/2026 · **Situação:** aceita

## Decisão
O Omni é a **camada de comunicação e de IA**. Ele não duplica a verdade de outro sistema.

| Assunto | Dono | O Omni |
|---|---|---|
| Missão, 11 etapas, checklists, papéis da missão, RDO, relatórios técnicos, Qualidade, romaneio, efetivo, custos, Omie | filtroAPP | lê pela API de integrações; escreve por rotas novas (ex.: abrir desvio) |
| Oportunidade, contato pessoa, contato CNPJ, feedback, número da missão | Prisma CRM | lê; registra feedback; upsert de contatos do cliente |
| Proposta (regime, viagem, permanência em obra, stand-by) | comercialAPP → filtroAPP | lê pelo filtroAPP |
| Conversas, canais Interno/Gerencial, IA, alertas, participantes, tarefas, auditoria | **Omni** | é o dono |

- Papéis da missão vêm do filtroAPP: líder de projetos (`leaderUserId`, o mesmo "planejador" que acompanha o projeto e confirma a descarga), gestor de contrato (`plannerUserId`), líder de campo (`operatorId`).
- Funções da empresa (Qualidade, Documentação, Medição, Faturamento, Coordenação de mobilização, Gerente comercial) são configuração no Omni — nenhum nome no código.
- Contatos do cliente detectados nas missões vão para o Prisma; terceiros (hotel, transportadora, fornecedor) ficam só no Omni.
- NF e CT-e ficam no Omie; o filtroAPP precisa passar a espelhar o CT-e.
