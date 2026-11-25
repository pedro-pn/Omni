-- Resumo das ligações gravadas pela IA (Fase 8; autorizado em 10/11/2026, entra
-- no registro de LGPD): o worker busca o áudio no serviço de voz, transcreve e
-- resume na OpenAI. A transcrição não é guardada; só o resumo, visível para quem
-- já ouve a gravação (dono e com quem ela foi compartilhada: app.ve_chamada).
-- Excluir a gravação apaga o resumo junto.

ALTER TABLE whatsapp_calls
  ADD COLUMN summary          jsonb,
  ADD COLUMN summary_status   text CHECK (summary_status IN ('pendente', 'resumida', 'sem_fala', 'erro')),
  ADD COLUMN summary_model    text,
  ADD COLUMN summarized_at    timestamptz,
  ADD COLUMN summary_attempts integer NOT NULL DEFAULT 0;

-- O worker lê só o necessário para achar o áudio e grava só o resumo.
GRANT SELECT (id, number_id, owner_person_id, recording_id, peer, direction, started_at, ended_at, audio,
              expires_at, deleted_at, summary_status, summary_attempts) ON whatsapp_calls TO omni_worker;
GRANT UPDATE (summary, summary_status, summary_model, summarized_at, summary_attempts) ON whatsapp_calls TO omni_worker;
CREATE POLICY calls_worker_ler ON whatsapp_calls FOR SELECT TO omni_worker USING (true);
CREATE POLICY calls_worker_resumo ON whatsapp_calls FOR UPDATE TO omni_worker USING (true) WITH CHECK (true);

CREATE FUNCTION app.apagar_resumo_da_gravacao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    NEW.summary := NULL;
    NEW.summary_status := NULL;
    NEW.summary_model := NULL;
    NEW.summarized_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_calls_apagar_resumo BEFORE UPDATE OF deleted_at ON whatsapp_calls
  FOR EACH ROW EXECUTE FUNCTION app.apagar_resumo_da_gravacao();
