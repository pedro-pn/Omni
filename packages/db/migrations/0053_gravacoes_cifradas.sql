-- Gravações cifradas no SharePoint (decisão de 11/11/2026): cada gravação tem a
-- própria chave, guardada aqui embrulhada pela chave mestra do servidor
-- (GRAVACOES_CHAVE_MESTRA, AES-256-GCM, presa ao id da ligação). No SharePoint fica
-- só o arquivo cifrado: nem os administradores do Microsoft 365 conseguem ouvir.
-- Excluir a gravação apaga a chave na hora (gatilho): o arquivo fica ilegível mesmo
-- se sobrar uma cópia no SharePoint ou numa política de retenção. Vencida, o worker
-- apaga a chave junto com o arquivo.

ALTER TABLE whatsapp_calls
  ADD COLUMN chave_cifrada bytea CHECK (octet_length(chave_cifrada) = 60),
  ADD COLUMN chave_versao  smallint CHECK (chave_versao > 0);

GRANT SELECT (chave_cifrada, chave_versao) ON whatsapp_calls TO omni_worker;
GRANT UPDATE (chave_cifrada, chave_versao) ON whatsapp_calls TO omni_worker;

CREATE FUNCTION app.descartar_chave_da_gravacao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      NEW.chave_cifrada := NULL;
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER whatsapp_calls_descartar_chave BEFORE UPDATE OF deleted_at ON whatsapp_calls
  FOR EACH ROW EXECUTE FUNCTION app.descartar_chave_da_gravacao();
