# ADR 0003 — O Foco será absorvido pelo Omni

- **Data:** 26/10/2026 · **Situação:** aceita (decisão do Otávio)

## Decisão
As tarefas passam a ser um módulo do Omni (Fase 3). **Primeiro migra, depois desliga** o Foco.

- Portar, não reescrever: `smart-parse.ts`, `batch-task-parser.ts` e `recurrence.ts` (TypeScript puro) com os testes; telas shadcn; políticas RLS adaptadas (`auth.uid()` → `app.current_person_id()`).
- Migração idempotente do Postgres do Foco (Supabase/Lovable) guardando `foco_id`; usuários casados por e-mail Entra; anexos do Storage para uma biblioteca do SharePoint dedicada ao Omni.
- API `/api/v1` compatível com o contrato do Foco, para o Prisma e automações não quebrarem.
- Corte: Foco somente leitura → carga final → redirecionar `foco.filtrovali.com.br` → 30 dias de conferência → desligar.

## Consequências
- Não se constrói integração com a API do Foco (seria descartada).
- Funcionalidades novas no Foco ficam congeladas durante a Fase 3.
