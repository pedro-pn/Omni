import { createPool } from "@omni/db";
import type pg from "pg";

import { getEnv } from "./env.ts";

let pool: pg.Pool | undefined;

/** Pool do papel omni_app (sujeito a RLS). Use sempre com `withPerson`. */
export function getPool(): pg.Pool {
  pool ??= createPool(getEnv().DATABASE_URL_APP);
  return pool;
}
