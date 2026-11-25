-- PDF dos relatórios pelo filtroAPP (spec 038, `rdo.relatorios.pdf.download`):
-- o indicador que vem na listagem (versão pronta no filtroAPP, nome do arquivo)
-- e, nos RDOs de manutenção, os documentos de manutenção ligados. O arquivo não
-- é guardado no Omni: o servidor busca no filtroAPP quando a pessoa abre.

ALTER TABLE reports
  ADD COLUMN pdf_disponivel      boolean,
  ADD COLUMN pdf_versao          text,
  ADD COLUMN pdf_nome            text,
  ADD COLUMN pdf_atualizado_em   timestamptz,
  ADD COLUMN pdf_anexos_manutencao text[] NOT NULL DEFAULT '{}';
