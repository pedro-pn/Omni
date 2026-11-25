-- Aba RDOs da missão: quem vê o Interno vê o que a IA apontou em cada RDO
-- (os mesmos pontos já são publicados no Interno pela pergunta rdo_leitura).
-- Só leitura; quem grava continua sendo o worker.

GRANT SELECT ON rdo_analyses TO omni_app;

CREATE POLICY rdo_analyses_interno ON rdo_analyses FOR SELECT TO omni_app
  USING (app.ve_interno(mission_id, app.current_person_id()));
