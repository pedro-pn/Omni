import { createHash } from "node:crypto";

import { TERMOS, textoDosTermos } from "@omni/core";

/** SHA-256 do texto da versão atual do termo: guardado em cada aceite, como prova do que foi lido. */
export const HASH_TERMOS = createHash("sha256").update(textoDosTermos(TERMOS), "utf8").digest("hex");
