-- 0007 · Escritas no filtroAPP em modo simulado (FILTROAPP_ESCRITA=simulada).
-- O desvio validado pelo filtroAPP sem gravar fica como 'simulado'.

ALTER TABLE ai_deviations DROP CONSTRAINT ai_deviations_status_check;
ALTER TABLE ai_deviations ADD CONSTRAINT ai_deviations_status_check
  CHECK (status IN ('pendente', 'enviado', 'simulado', 'ensaio', 'falhou'));
