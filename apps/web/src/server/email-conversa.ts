import { schema } from "@omni/db";
import { sql } from "drizzle-orm";

/**
 * O e-mail (mail_items) é da conversa entre a pessoa da sessão e quem tem estes endereços (lista
 * no formato de array do Postgres): recebido dela com a pessoa da sessão no Para, ou enviado pela
 * pessoa da sessão com ela no Para. Cópia não conta (0092, app.email_da_conversa).
 */
export const daConversa = (lista: string) =>
  sql`app.email_da_conversa(${schema.mailItems.folder}, ${schema.mailItems.fromAddress}, ${schema.mailItems.toRecipients}, ${lista}::text[], (SELECT email FROM people WHERE id = app.current_person_id()))`;
