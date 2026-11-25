# Pedido ao filtroAPP: itens das pendências da etapa (checklist) para o Omni

> Escrito em 16/11/2026. O Omni já mostra, no Resumo da missão, a **prontidão da
> etapa** com o que `/efetivo/projetos/:id/status` entrega: comercial liberado
> (`commercialReadiness`), mobilização e encerramento liberados (`mobilizationReady`,
> `closureReady`) e a contagem de pendências (`openIssueCount`, `criticalIssueCount`).
> O planejamento do Omni (Fase 2) prevê mostrar também **o checklist da etapa**, só
> leitura, com o link para resolver no filtroAPP. Hoje o escopo
> `efetivo.projetos.status.read` exclui de propósito "textos de pendências".

## O que pedimos

1. **Itens que bloqueiam a mobilização e o encerramento**, por projeto: para cada item
   do `mobilizationGate` e do `closureGate`, a chave, o rótulo (ex.: "Integração do
   cliente agendada", "Documentação da equipe completa"), a situação (ok / pendente /
   não se aplica) e a criticidade. Sem nomes de pessoas nem textos livres.
2. **Pendências abertas** (`issues`): título curto, criticidade, a etapa a que se
   referem e a data de abertura — sem a descrição livre, se ela puder conter dados
   pessoais.
3. **Fatos comerciais pendentes** (`commercialReadiness`): a lista de rótulos que
   impedem a liberação (`blockers`).
4. **Endereço da página do projeto** no filtroAPP (ou o padrão do caminho), para o
   botão "Resolver no filtroAPP".

Pode ser um campo novo no mesmo `/efetivo/projetos/:id/status` (ex.: `gates`), com um
escopo próprio (ex.: `efetivo.projetos.pendencias.read`), para quem não precisa
continuar sem ver os itens.

## O que o Omni faz com isso

- Mostra os itens, só leitura, no bloco "Prontidão da etapa" do Resumo da missão,
  para quem vê a missão (`app.ve_missao`).
- A IA pode deixar de perguntar o que o checklist já respondeu (regra do planejamento:
  "a IA não pergunta o que o filtroAPP já sabe").
