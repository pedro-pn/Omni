/**
 * Rotas públicas do Omni (E14, pilares 7 e 8): as rotas de servidor que respondem SEM a sessão de quem
 * está logado. Todo o resto (telas, server functions e as demais rotas de /api) exige sessão e o
 * aceite do termo, e os dados passam pelo RLS com a identidade da pessoa.
 *
 * Esta lista é a fonte da verdade: `rotas-publicas.test.ts` lê os arquivos de rota e falha se uma rota
 * sem `personIdFromRequest` não estiver aqui (ou se uma daqui passar a exigir sessão). Rota pública nova
 * entra aqui com quem chama e qual credencial confere; detalhes em docs/producao/rotas-publicas.md.
 *
 * Arquivos estáticos de apps/web/public (marca, ícones, áudio, manifest, sw.js, openapi.json) e os
 * /assets do build também são públicos e não trazem dado de ninguém.
 */
export type RotaPublica = {
  caminho: string;
  metodos: string[];
  quemChama: string;
  credencial: string;
  /** "internet": precisa ficar aberta no Caddy; "interna": só a rede do Docker chama (Caddy recusa). */
  exposicao: "internet" | "interna";
};

export const ROTAS_PUBLICAS: RotaPublica[] = [
  {
    caminho: "/api/saude",
    metodos: ["GET"],
    quemChama: "deploy/publicar.sh, Docker (healthcheck) e monitoramento",
    credencial: "nenhuma; devolve só status, banco e versão",
    exposicao: "internet",
  },
  {
    caminho: "/api/csp-relatorio",
    metodos: ["POST"],
    quemChama: "navegador (relatório de violação da CSP)",
    credencial: "nenhuma; até 16 KB, guarda só a diretiva e a origem bloqueada (E12)",
    exposicao: "internet",
  },
  {
    caminho: "/api/v1/$",
    metodos: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    quemChama: "Prisma e automações (API de tarefas, contrato em public/openapi.json)",
    credencial: "chave pessoal Bearer (só o SHA-256 no banco) com escopos; /health e /openapi.json sem chave",
    exposicao: "internet",
  },
  {
    caminho: "/api/prisma-authorization/token",
    metodos: ["POST"],
    quemChama: "servidor do Prisma",
    credencial: "código de uso único (5 min) + PKCE S256; Origin, se vier, só a do Prisma",
    exposicao: "internet",
  },
  {
    caminho: "/api/prisma-authorization/revoke",
    metodos: ["POST"],
    quemChama: "servidor do Prisma",
    credencial: "a própria chave do Prisma no corpo; só revoga chaves do cliente prisma",
    exposicao: "internet",
  },
  {
    caminho: "/api/calendar/apple/feed/$token",
    metodos: ["GET"],
    quemChama: "aplicativos de agenda (assinatura .ics)",
    credencial: "link privado assinado (APPLE_CALENDAR_SIGNING_KEY); pode ser trocado ou desativado",
    exposicao: "internet",
  },
  {
    caminho: "/api/graph/avisos",
    metodos: ["POST"],
    quemChama: "Microsoft Graph (aviso de e-mail novo)",
    credencial: "clientState de cada assinatura (só o SHA-256 no banco); só acorda o worker",
    exposicao: "internet",
  },
  {
    caminho: "/api/whatsapp/webhook",
    metodos: ["POST"],
    quemChama: "Evolution do Omni, em http://web:3000",
    credencial: "segredo no cabeçalho (WHATSAPP_WEBHOOK_SECRET)",
    exposicao: "interna",
  },
  {
    caminho: "/api/chamadas/eventos",
    metodos: ["POST"],
    quemChama: "serviço de voz, em http://web:3000",
    credencial: "chave Bearer (CHAMADAS_SERVICO_KEY) comparada em tempo constante",
    exposicao: "interna",
  },
  {
    caminho: "/auth/microsoft",
    metodos: ["GET"],
    quemChama: "navegador (início do login Microsoft)",
    credencial: "nenhuma; cria o fluxo OIDC (state, nonce e PKCE em cookie selado)",
    exposicao: "internet",
  },
  {
    caminho: "/auth/callback",
    metodos: ["GET"],
    quemChama: "navegador, de volta do Entra",
    credencial: "state e PKCE do cookie do fluxo; token conferido no Entra",
    exposicao: "internet",
  },
  {
    caminho: "/auth/dev",
    metodos: ["POST"],
    quemChama: "navegador, só no desenvolvimento",
    credencial: "recusada fora do desenvolvimento (AUTH_DEV_LOGIN, NODE_ENV e OMNI_AMBIENTE)",
    exposicao: "internet",
  },
  {
    caminho: "/auth/sair",
    metodos: ["POST"],
    quemChama: "navegador",
    credencial: "mesma origem; só encerra a sessão do próprio cookie",
    exposicao: "internet",
  },
];
