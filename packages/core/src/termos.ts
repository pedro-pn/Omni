/**
 * Termo de uso e privacidade do Omni (LGPD), aceito no primeiro acesso.
 * Mudou o texto? Troque a `versao` (data da mudança): todos confirmam de novo.
 * O banco guarda, por pessoa, a versão aceita e o SHA-256 do texto daquela versão
 * (calculado no servidor: apps/web/src/server/termos.ts).
 * O texto deve ser validado pelo encarregado de dados (docs/producao/lgpd-ropa-dpa.md).
 */

export type SecaoTermos = { titulo: string; itens: string[] };

export const TERMOS = {
  versao: "2026-11-24",
  titulo: "Termo de uso e privacidade do Omni",
  introducao:
    "O Omni é a ferramenta de trabalho da Filtrovali para a comunicação das missões e dos clientes. Leia com atenção: para usar o Omni, você precisa confirmar que leu e está de acordo.",
  secoes: [
    {
      titulo: "1. Para que serve e quem acessa",
      itens: [
        "O Omni é de uso exclusivo para o trabalho. Você entra com a sua conta Microsoft da Filtrovali, liberada pela Administração.",
        "Cada pessoa vê só o que o perfil e as missões dela permitem. As regras de acesso ficam no próprio banco de dados, não só na tela.",
        "Ações importantes ficam registradas com data, hora e autor: entrar, abrir um e-mail, mudar perfis e acessos, compartilhar ou excluir uma gravação.",
        "Downloads de arquivos (pastas, anexos, relatórios, gravações) e arquivos enviados para fora da empresa também ficam registrados. Quantidade fora do comum em pouco tempo gera um alerta para a Administração e a diretoria, para proteger os dados da empresa e dos clientes.",
      ],
    },
    {
      titulo: "2. E-mails e arquivos",
      itens: [
        "A sua caixa de e-mail da Filtrovali passa a ser lida pelo Omni quando você entra pela primeira vez. Para juntar e-mails e WhatsApp e avisar de e-mail novo, o Omni guarda o cabeçalho dos e-mails da sua Entrada e dos Enviados (remetente, destinatários, assunto, prévia e data) — só você vê. O texto completo continua lido na hora no Microsoft 365.",
        "A agenda de contatos do Omni é da empresa: e-mails e telefones de clientes e parceiros que alguém vincula ficam visíveis para quem usa o Omni. Os contatos do seu celular não entram nela sozinhos.",
        "E-mails ligados a missões, das caixas no Omni, ficam visíveis dentro do Omni para a diretoria e os gerentes. Só entram e-mails ligados a uma missão (pelo número da missão, por códigos citados ou pelo domínio do cliente).",
        "O Omni guarda só o cabeçalho e uma prévia de cada e-mail; o texto completo é lido no Outlook na hora de abrir, e cada abertura fica registrada.",
        "Quem envia e-mail pelo Omni envia só da própria caixa.",
        "Pastas do SharePoint de oportunidades e missões aparecem para quem já tem direito a elas.",
      ],
    },
    {
      titulo: "3. WhatsApp",
      itens: [
        "Os números conectados ao Omni ficam registrados nele. As conversas de cada número são vistas só pelo responsável por ele: nem a Administração nem a diretoria veem.",
        "O histórico das suas conversas, que o celular manda ao conectar, fica no servidor de WhatsApp do Omni e é baixado só para o aparelho em que você usa o Omni, como no WhatsApp Web. Ao sair do Omni, ele é apagado do aparelho.",
        "Grupos do WhatsApp ligados a uma missão aparecem também, dentro da missão, para a equipe dela.",
        "Nomes e fotos de perfil dos contatos e grupos aparecem na lista de conversas. A foto não é guardada no Omni.",
        "Mensagens do Interno e do Gerencial nunca saem pelo WhatsApp.",
      ],
    },
    {
      titulo: "4. Ligações pelo Omni",
      itens: [
        "Cada pessoa liga e atende pelo próprio número conectado; só ela controla as ligações da linha dela.",
        "Gravar exige permissão da Administração e, em cada ligação, marcar \"Gravar esta ligação\" e avisar os participantes antes.",
        "As gravações são privadas de quem gravou. Você pode compartilhar uma gravação com pessoas escolhidas e revogar quando quiser. A Administração e a diretoria não ouvem sem esse compartilhamento.",
        "As gravações ficam guardadas por 5 anos, ou até você excluí-las. Depois de excluída, uma gravação ainda pode existir por até 14 dias nas cópias de segurança.",
        "As gravações ficam no SharePoint da Filtrovali, cifradas, cada uma com a própria chave: só são ouvidas pelo Omni, por quem gravou e por quem ela compartilhar. Nem a equipe que administra o Microsoft 365 consegue ouvi-las.",
        "Excluir uma gravação apaga também a chave que a abre: a partir daí ela não pode mais ser ouvida.",
      ],
    },
    {
      titulo: "5. Assistente (IA)",
      itens: [
        "O Omni usa a API da OpenAI para ler RDOs e as mensagens enviadas ao assistente, sugerir perguntas e alertas, resumir reuniões do Teams que citam uma missão e ler nome, cargo, empresa e telefone na assinatura dos e-mails de quem escreve de fora da empresa (só o final do e-mail mais recente de cada remetente; o texto não fica guardado). Telefones citados no corpo dos e-mails são encontrados pelo próprio Omni, sem IA, e aparecem só como sugestão para vincular ao contato.",
        "Uma ligação gravada só é resumida quando quem gravou pede (\"Resumir com IA\"). O Omni guarda a transcrição e o resumo junto da gravação, visíveis só para quem pode ouvi-la; excluir a gravação apaga os dois.",
        "O provedor não guarda nem usa esses dados para treinar modelos (retenção zero contratada).",
        "A IA sugere; quem decide é sempre uma pessoa.",
      ],
    },
    {
      titulo: "6. Avisos e notificações",
      itens: [
        "O Omni avisa no sino, no celular (se você ativar) e por e-mail. As preferências ficam em Notificações e app, no menu do seu perfil.",
      ],
    },
    {
      titulo: "7. Suas responsabilidades",
      itens: [
        "Não compartilhe o seu acesso e saia do Omni em aparelhos que não são seus.",
        "Use os dados de clientes, colegas e missões só para o trabalho e só pelos canais da empresa.",
        "Avise os participantes antes de gravar uma ligação.",
        "Se perceber acesso indevido ou vazamento de dados, avise na hora o encarregado de dados.",
      ],
    },
    {
      titulo: "8. Seus direitos",
      itens: [
        "Você pode pedir acesso, correção e informações sobre os seus dados tratados no Omni. A base legal e os prazos estão na política de privacidade interna da Filtrovali.",
        "Dúvidas e pedidos: privacidade@filtrovali.com.br (encarregado de dados).",
      ],
    },
  ] satisfies SecaoTermos[],
  rodape: "Quando este termo mudar, o Omni pede uma nova confirmação.",
} as const;

/** Texto corrido da versão atual (o que é assinado pelo SHA-256 guardado no aceite). */
export function textoDosTermos(t: typeof TERMOS = TERMOS): string {
  return [t.titulo, `Versão ${t.versao}`, t.introducao, ...t.secoes.flatMap((s) => [s.titulo, ...s.itens]), t.rodape].join("\n");
}
