/**
 * Leitura do Foco para a migração (Fase 3): pela API do Supabase (PostgREST, Auth e
 * Storage) com a chave de serviço, **só GET** — nada é escrito no Foco. A API REST é a
 * fonte certa também por um detalhe: a assinatura dos feeds de agenda do Foco usa o
 * `created_at` como texto, no formato que essa API devolve.
 */

export type Linha = Record<string, unknown>;
export type UsuarioFoco = { id: string; email: string | null };

export interface FonteFoco {
  /** Todas as linhas de uma tabela de `public`; `null` quando a tabela não existe. */
  tabela(nome: string): Promise<Linha[] | null>;
  /** Usuários do login do Foco (só id e e-mail). */
  usuarios(): Promise<UsuarioFoco[]>;
  /** Conteúdo de um anexo do bucket `foco-attachments`. */
  arquivo(chave: string): Promise<Uint8Array>;
}

export class FocoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FocoError";
  }
}

/** Ordem estável para paginar (a chave de cada tabela). */
const ORDEM: Record<string, string> = {
  comment_mentions: "comment_id,user_id",
  comment_reactions: "comment_id,user_id,emoji",
  project_members: "project_id,user_id",
  pending_project_members: "project_id,email",
  workspace_members: "workspace_id,user_id",
  user_notification_settings: "user_id",
  project_message_mentions: "message_id,user_id",
  prisma_authorization_grants: "key_id",
  members: "user_id",
};
const POR_PAGINA = 1000;
const BUCKET = "foco-attachments";

export function fonteSupabase(url: string, chave: string, buscar: typeof fetch = fetch): FonteFoco {
  const base = url.replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) throw new FocoError("Endereço do Supabase inválido (esperado https://<projeto>.supabase.co).");
  const cabecalhos = { apikey: chave, Authorization: `Bearer ${chave}` };
  // Só leitura: nenhum outro método sai daqui.
  const get = async (caminho: string, extra: Record<string, string> = {}) => {
    const r = await buscar(`${base}${caminho}`, { method: "GET", headers: { ...cabecalhos, ...extra } });
    return r;
  };
  return {
    async tabela(nome) {
      if (!/^[a-z_]+$/.test(nome)) throw new FocoError("Tabela inválida.");
      const linhas: Linha[] = [];
      for (let inicio = 0; ; inicio += POR_PAGINA) {
        const ordem = (ORDEM[nome] ?? "id").split(",").map((c) => `${c}.asc`).join(",");
        const r = await get(`/rest/v1/${nome}?select=*&order=${ordem}&limit=${POR_PAGINA}&offset=${inicio}`, { Accept: "application/json" });
        if (r.status === 404) return null;
        if (!r.ok) {
          const corpo = (await r.json().catch(() => null)) as { code?: string } | null;
          if (corpo?.code === "PGRST205" || corpo?.code === "42P01") return null; // tabela não existe
          if (r.status === 401 || r.status === 403) throw new FocoError(`O Supabase do Foco recusou a chave (${r.status}). Confira a FOCO_SUPABASE_SERVICE_ROLE_KEY: é a chave service_role (JWT "eyJ…") ou a secreta ("sb_secret_…"), não a de assinatura da agenda.`, r.status);
          throw new FocoError(`Leitura de ${nome} falhou (${r.status}).`, r.status);
        }
        const pagina = (await r.json()) as Linha[];
        linhas.push(...pagina);
        if (pagina.length < POR_PAGINA) return linhas;
      }
    },
    async usuarios() {
      const todos: UsuarioFoco[] = [];
      for (let pagina = 1; ; pagina += 1) {
        const r = await get(`/auth/v1/admin/users?page=${pagina}&per_page=${POR_PAGINA}`);
        if (!r.ok) throw new FocoError("Leitura dos usuários do Foco falhou.", r.status);
        const { users } = (await r.json()) as { users: { id: string; email?: string | null }[] };
        todos.push(...users.map((u) => ({ id: u.id, email: u.email ?? null })));
        if (users.length < POR_PAGINA) return todos;
      }
    },
    async arquivo(chaveDoObjeto) {
      if (chaveDoObjeto.includes("..")) throw new FocoError("Caminho de anexo inválido.");
      const caminho = chaveDoObjeto.split("/").map(encodeURIComponent).join("/");
      const r = await get(`/storage/v1/object/${BUCKET}/${caminho}`);
      if (!r.ok) throw new FocoError("Anexo não encontrado no Foco.", r.status);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/**
 * Leitura pela função de exportação do Foco (`docs/integracoes/foco-exportacao.sql`), para
 * quando a chave de serviço não está disponível (Lovable Cloud): GET na API pública do
 * Supabase com a chave publicável e o segredo da exportação no cabeçalho `x-omni-token`.
 * Tabelas sem destino voltam só com a contagem. Os anexos vêm do pacote do desenvolvedor
 * (os arquivos numa pasta, no caminho `object_key`, e a lista `caminho;tamanho;sha256`).
 */
export function fonteExportacao(url: string, chavePublica: string, segredo: string, pastaAnexos: string | null, ler: (caminho: string) => Promise<Uint8Array> = lerArquivoLocal, buscar: typeof fetch = fetch): FonteFoco {
  const base = url.replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) throw new FocoError("Endereço do Supabase inválido (esperado https://<projeto>.supabase.co).");
  const exportar = async (tabela: string): Promise<unknown> => {
    const r = await buscar(`${base}/rest/v1/rpc/omni_exportar?p_tabela=${encodeURIComponent(tabela)}`, {
      method: "GET",
      headers: { apikey: chavePublica, "x-omni-token": segredo, Accept: "application/json" },
    });
    if (!r.ok) {
      const corpo = (await r.json().catch(() => null)) as { code?: string; message?: string } | null;
      if (corpo?.code === "PGRST202") throw new FocoError("A função omni_exportar não existe no Foco (falta aplicar docs/integracoes/foco-exportacao.sql).", r.status);
      if (corpo?.code === "42501" || r.status === 401 || r.status === 403) throw new FocoError(`O Foco recusou a exportação (${r.status}): confira o segredo (FOCO_EXPORT_TOKEN), a validade dele e a chave publicável.`, r.status);
      throw new FocoError(`Exportação de ${tabela} falhou (${r.status}).`, r.status);
    }
    return r.json();
  };
  return {
    async tabela(nome) {
      if (!/^[a-z_]+$/.test(nome)) throw new FocoError("Tabela inválida.");
      const v = await exportar(nome);
      if (v === null) return null;
      if (Array.isArray(v)) return v as Linha[];
      const total = Number((v as { total?: unknown }).total ?? 0);
      return Array.from({ length: total }, () => ({})); // só a contagem
    },
    async usuarios() {
      const v = (await exportar("auth.users")) as { id: string; email?: string | null }[];
      return v.map((u) => ({ id: u.id, email: u.email ?? null }));
    },
    async arquivo(chave) {
      if (!pastaAnexos) throw new FocoError("anexo não disponível: falta a pasta do pacote (FOCO_ANEXOS_PASTA)");
      if (chave.includes("..") || chave.startsWith("/")) throw new FocoError("Caminho de anexo inválido.");
      try {
        return await ler(`${pastaAnexos.replace(/\/+$/, "")}/${chave}`);
      } catch {
        throw new FocoError("anexo não encontrado no pacote");
      }
    },
  };
}

async function lerArquivoLocal(caminho: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(caminho));
}
