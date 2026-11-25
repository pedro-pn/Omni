-- 0019 · Meta da semana como está cadastrada no filtroAPP (complemento do B6/G1):
-- unidades físicas (m, L, un, colaboradores/dia), por serviço, com o realizado
-- calculado pelos RDOs. Cópia do objeto `meta` da API, sem dados pessoais (a
-- presença diária só traz quantidades). Mesmas permissões da tabela (0018).

ALTER TABLE mission_weekly_progress ADD COLUMN meta jsonb;
