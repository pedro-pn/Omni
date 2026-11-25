import { migrate } from "../migrate.ts";

const url = process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error("Defina DATABASE_URL_OWNER (papel dono do banco).");
  process.exit(1);
}

const result = await migrate(url);
for (const name of result.applied) console.log(`aplicada  ${name}`);
console.log(`${result.applied.length} aplicada(s), ${result.skipped.length} já estavam aplicadas.`);
