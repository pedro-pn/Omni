import type { Db } from "@omni/db";
import { sql } from "drizzle-orm";

/**
 * Lembretes de tarefas (Fase 3; `reminder_offset_minutes` do Foco).
 * Na hora pedida (data + hora da tarefa, 09:00 sem hora, menos a antecedência)
 * avisa no sino quem está com a tarefa: o responsável, o dono da caixa pessoal
 * ou, sem nenhum dos dois, quem criou. Tarefa que repete lembra de novo a cada
 * ocorrência (o horário muda com a data). Lembrete com mais de um dia de atraso
 * (worker parado, data no passado) não é enviado.
 * Não segue a janela útil: o horário foi escolhido pela própria pessoa.
 */
export async function enviarLembretes(db: Db, agora: Date = new Date()): Promise<{ enviados: number }> {
  const r = await db.execute<{ id: string }>(sql`
    WITH devidos AS (
      SELECT t.id, t.content, t.due_date, t.due_time,
             coalesce(t.assignee_person_id, t.owner_person_id, t.created_by) AS para,
             app.horario_lembrete(t.due_date, t.due_time, t.reminder_offset_minutes) AS alvo
        FROM tasks t
       WHERE NOT t.completed AND t.reminder_offset_minutes IS NOT NULL
    ), enviar AS (
      SELECT * FROM devidos d
       WHERE d.alvo <= ${agora}::timestamptz AND d.alvo > ${agora}::timestamptz - interval '1 day'
         AND NOT EXISTS (
           SELECT 1 FROM tasks t WHERE t.id = d.id AND t.reminder_sent_at IS NOT NULL AND t.reminder_sent_at >= d.alvo
         )
    ), avisos AS (
      INSERT INTO notifications (person_id, kind, title, body, task_id, dedupe_key)
      SELECT para, 'tarefa_lembrete', 'Lembrete: ' || left(content, 120),
             'Para ' || to_char(due_date, 'DD/MM') || coalesce(' às ' || to_char(due_time, 'HH24:MI'), ''),
             id, 'lembrete:' || id || ':' || alvo
        FROM enviar
      ON CONFLICT (dedupe_key) DO NOTHING
    )
    UPDATE tasks t SET reminder_sent_at = ${agora}::timestamptz FROM enviar e WHERE t.id = e.id
    RETURNING t.id`);
  return { enviados: r.rows.length };
}
