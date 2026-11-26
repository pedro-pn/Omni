/**
 * Primeiro script da página, antes de qualquer módulo (clássico, no <head>):
 * - o Zod não testa `Function()` para acelerar validações: a CSP (E12) não libera eval, e o teste
 *   gerava um relatório de violação a cada página. O Zod lê `__zod_globalConfig` ao criar cada
 *   esquema, então precisa estar definido antes de qualquer módulo carregar;
 * - aplica o tema salvo antes da primeira pintura (evita piscar). Sem localStorage, segue o sistema.
 *
 * Texto fixo: a CSP (apps/web/src/server/csp.ts) libera este script pelo hash SHA-256 dele, então
 * qualquer mudança aqui muda o hash sozinha, sem editar a política.
 */
export const SCRIPT_INICIAL =
  `globalThis.__zod_globalConfig=Object.assign(globalThis.__zod_globalConfig||{},{jitless:true});` +
  `try{var t=localStorage.getItem("omni-tema");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;
