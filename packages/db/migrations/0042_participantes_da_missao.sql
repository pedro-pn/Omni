-- Participantes da missão (INSTRUCOES §6.7): a lista é montada na hora a partir
-- dos e-mails da missão e dos grupos do WhatsApp ligados a ela (cada fonte com a
-- regra dela). Aqui fica só o que a equipe completa à mão: nome, cargo, empresa,
-- lado (cliente/terceiro/Filtrovali) e "não é participante". Quem vê o Interno
-- da missão lê e completa.

CREATE TABLE mission_participant_notes (
  mission_id  uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  chave       text NOT NULL CHECK (chave ~ '^(email|wa):.{3,200}$'),
  nome        text CHECK (length(nome) <= 120),
  cargo       text CHECK (length(cargo) <= 120),
  empresa     text CHECK (length(empresa) <= 120),
  lado        text CHECK (lado IN ('cliente', 'filtrovali', 'terceiro')),
  oculto      boolean NOT NULL DEFAULT false,
  updated_by  uuid NOT NULL REFERENCES people(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, chave)
);

GRANT SELECT, INSERT, UPDATE ON mission_participant_notes TO omni_app;
ALTER TABLE mission_participant_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY participant_notes_interno ON mission_participant_notes FOR ALL TO omni_app
  USING (app.ve_interno(mission_id, app.current_person_id()))
  WITH CHECK (app.ve_interno(mission_id, app.current_person_id()) AND updated_by = app.current_person_id());
