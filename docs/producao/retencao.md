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

## Para decidir (dados de negócio)

Sem prazo definido, ficam guardados. Sugestões para levar ao encarregado de dados:

| Dado | Sugestão |
|---|---|
| Mensagens do Interno e do Gerencial (e arquivos no SharePoint) | 5 anos depois do encerramento da missão (garantia/obra) |
| Conversas do WhatsApp no banco do Omni (mensagens recebidas ao vivo) | 5 anos; histórico do aparelho some ao sair |
| E-mails ligados a missões (cabeçalho, prévia, motivo) | 5 anos depois do encerramento da missão |
| E-mails enviados pelo Omni (`mail_outbox`, com o corpo) | 5 anos |
| Reuniões do Teams (resumo, decisões, pendências) | 5 anos depois do encerramento da missão |
| Transcrições e resumos das ligações | seguem a gravação (5 anos) |
| Tarefas concluídas e comentários | manter (como no Foco) |

## Antes de ligar `RETENCAO=real` na produção

1. Deixar alguns dias em `ensaio` e conferir no log do worker as contagens (`"job":"retencao"`).
2. Ter o backup do Omni funcionando (hoje não há: ver `PLANEJAMENTO.md`, situação de 16/11/2026).
3. Trocar no `.env.production` e subir de novo o worker.
