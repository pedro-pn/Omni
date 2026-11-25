-- Transcrição das ligações gravadas (13/11/2026, pedido do dono do produto; antes
-- só o resumo ficava). Mesma regra do resumo: vê quem já ouve a gravação (dono e
-- com quem ela foi compartilhada, RLS de whatsapp_calls), só depois de o dono pedir
-- "Resumir com IA". Excluir a gravação apaga a transcrição junto (gatilho), e o
-- worker apaga quando a gravação vence.

ALTER TABLE whatsapp_calls ADD COLUMN transcript text CHECK (length(transcript) <= 500000);
GRANT UPDATE (transcript) ON whatsapp_calls TO omni_worker;

CREATE OR REPLACE FUNCTION app.apagar_resumo_da_gravacao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    NEW.summary := NULL;
    NEW.summary_status := NULL;
    NEW.summary_model := NULL;
    NEW.summarized_at := NULL;
    NEW.transcript := NULL;
  END IF;
  RETURN NEW;
END $$;

-- Ligações resumidas antes da transcrição ser guardada: o dono pode pedir de novo
-- (transcreve e resume outra vez).
CREATE OR REPLACE FUNCTION app.pedir_resumo_chamada(p_call uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT app.chamada_dono(p_call) THEN RETURN false; END IF;
  UPDATE whatsapp_calls
     SET summary_status = 'pendente', summary_attempts = 0
   WHERE id = p_call AND audio AND deleted_at IS NULL AND ended_at IS NOT NULL AND expires_at > now()
     AND (summary_status IS NULL OR summary_status = 'erro' OR (summary_status = 'resumida' AND transcript IS NULL));
  RETURN FOUND;
END $$;
