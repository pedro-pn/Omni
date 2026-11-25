-- Gravações das ligações no SharePoint (site OmniAnexos, só o app do Omni escreve):
-- terminada a ligação, o worker comprime em M4A (AAC), envia, confere o tamanho e só
-- então apaga o WAV do serviço de voz. Ouvir continua pelo Omni (quem pode ouvir é o
-- banco que decide). Excluída pelo dono ou vencida (5 anos), o arquivo é apagado de
-- vez no SharePoint, sem passar pela lixeira.

ALTER TABLE whatsapp_calls
  ADD COLUMN arquivo_local         text NOT NULL DEFAULT 'voz' CHECK (arquivo_local IN ('voz', 'sharepoint')),
  ADD COLUMN sp_drive_id           text,
  ADD COLUMN sp_item_id            text,
  ADD COLUMN arquivo_bytes         bigint CHECK (arquivo_bytes >= 0),
  ADD COLUMN arquivo_formato       text CHECK (arquivo_formato IN ('wav', 'm4a')),
  ADD COLUMN arquivado_em          timestamptz,
  ADD COLUMN arquivamento_tentativas integer NOT NULL DEFAULT 0,
  ADD COLUMN sp_apagado_em         timestamptz,
  ADD CONSTRAINT whatsapp_calls_sharepoint CHECK (arquivo_local = 'voz' OR (sp_drive_id IS NOT NULL AND sp_item_id IS NOT NULL));

CREATE INDEX whatsapp_calls_para_arquivar ON whatsapp_calls (ended_at) WHERE audio AND arquivo_local = 'voz' AND deleted_at IS NULL;
CREATE INDEX whatsapp_calls_para_apagar ON whatsapp_calls (expires_at) WHERE sp_item_id IS NOT NULL AND sp_apagado_em IS NULL;

-- O worker arquiva e apaga; não mexe no resto da ligação (nem em `audio`: vencida, o
-- Omni já esconde pela data, expires_at).
GRANT SELECT (arquivo_local, sp_drive_id, sp_item_id, arquivo_formato, arquivamento_tentativas, sp_apagado_em) ON whatsapp_calls TO omni_worker;
GRANT UPDATE (arquivo_local, sp_drive_id, sp_item_id, arquivo_bytes, arquivo_formato, arquivado_em, arquivamento_tentativas, sp_apagado_em) ON whatsapp_calls TO omni_worker;
