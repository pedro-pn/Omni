# Retenção por tipo de dado

> 16/11/2026 (Fase 11). O job `retencao` do worker roda todo dia às 03:40 e chama
> `app.aplicar_retencao` (migration 0066), onde ficam **todos os prazos**. Com
> `RETENCAO=ensaio` (padrão) ele só conta o que apagaria e registra no log do worker
> (`"job":"retencao"`); com `RETENCAO=real` apaga. `desligada` não roda.
> Para mudar um prazo: nova migration com `CREATE OR REPLACE FUNCTION app.aplicar_retencao`.

## Em vigor (dados técnicos)

| Dado | Prazo | Como |
|---|---|---|
| Sessões de login | 30 dias depois de expirar ou ser encerrada | apaga |
| Avisos do sino | lidos: 180 dias; qualquer um: 1 ano | apaga |
| Registro dos e-mails de aviso (`notification_emails`) | 1 ano | apaga |
| Metadados das chamadas à IA (`llm_calls`, sem texto) | 1 ano | apaga |
| Registro de downloads (`audit_log` "arquivo.baixado") | 1 ano | apaga (única exceção à auditoria só de inserção) |
| Alertas de risco | 2 anos | apaga |
| Aceite do termo de uso | IP e navegador anonimizados depois de 2 anos | mantém versão, resumo (SHA-256) e data: é a prova do aceite |
| Gravações das ligações | 5 anos (ou até o dono excluir) | já em vigor desde 11/11/2026 (`CHAMADA_RETENCAO_HORAS`, `chamadas-arquivar`) |

O restante da auditoria (`audit_log`: perfis, acessos, abertura de e-mails, compartilhamentos)
**não é apagado** (é só de inserção).

## Em vigor (dados de negócio, migration 0081)

Decididos em 26/11/2026 (E15). Missão **encerrada** = inativa e com o ciclo ou a missão fechados
(`cycle_closed_at` ou `closed_at`); missão sem essa data nunca vence.

| Dado | Prazo | Como |
|---|---|---|
| Mensagens do Interno e do Gerencial, com os arquivos no SharePoint | 5 anos depois do encerramento da missão | apaga; arquivos apagados de vez pelo worker |
| Perguntas da IA da missão (e os desvios e descargas que geraram) | 5 anos depois do encerramento da missão | apaga (a verdade de desvios e descargas fica no filtroAPP) |
| E-mails ligados a missões (cabeçalho, prévia, motivo, quem abriu) | 5 anos depois do encerramento de **todas** as missões ligadas; sem ligação, 5 anos do recebimento | apaga |
| Reuniões do Teams (resumo, decisões, pendências) | igual aos e-mails | apaga |
| Mensagens do WhatsApp guardadas no Omni | 5 anos | apaga |
| E-mails e mensagens enviados pelo Omni (`mail_outbox`, `whatsapp_outbox`) | 5 anos | apaga |
| Cabeçalhos da caixa pessoal (caixa única, `mail_items`) | 1 ano depois da janela de 90 dias (455 dias) | apaga |
| Tarefas pessoais (caixa própria, fora de projeto) e anexos | 2 anos depois da desativação da pessoa (`people.deactivated_at`, marcado por gatilho) | apaga; anexos apagados de vez pelo worker |
| Transcrições e resumos das ligações | seguem a gravação (5 anos) | já em vigor |
| Tarefas de projetos, comentários e histórico | mantidos (são do projeto) | — |

**Arquivos no SharePoint:** a função não apaga direto. Ela põe o drive e o item de cada arquivo
vencido em `arquivos_para_apagar`, na mesma transação, e o job `retencao` apaga de vez
(`apps/worker/src/operacao/retencao.ts`). O que falhar tenta de novo na noite seguinte; depois de
5 tentativas o job falha e vira erro do sistema (Administração → Erros).

## Ligar `RETENCAO=real` na produção

1. Com a versão da 0081 no ar, conferir as contagens do ensaio na VPS:
   `docker exec omni-postgres-1 psql -U omni_owner -d omni -c "SELECT jsonb_pretty(app.aplicar_retencao(false))"`
   (ensaio não muda nada). O log do worker também mostra o resultado das 03:40 (`"job":"retencao"`).
2. Backup no B2 funcionando (em vigor desde 25/11/2026, `docs/producao/backup.md`).
3. Trocar `RETENCAO=real` no `deploy/.env.production` e publicar (`deploy/publicar.sh producao`).
