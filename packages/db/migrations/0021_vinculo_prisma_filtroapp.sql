-- 0021 · Vínculo oficial missão do Prisma ↔ projeto do filtroAPP (contrato
-- filtroAPP "prisma-progress", 04/11/2026): GET /projetos traz
-- `prisma { missionId, number, numberScope }` (só vínculos de produção do Prisma).
-- O worker guarda aqui e passa a ligar prisma_mission_links com o método
-- 'filtroapp', que tem prioridade sobre o número.

ALTER TABLE missions
  ADD COLUMN prisma_mission_id   text,
  ADD COLUMN prisma_number_scope text;
CREATE INDEX missions_prisma_mission ON missions (prisma_mission_id) WHERE prisma_mission_id IS NOT NULL;
