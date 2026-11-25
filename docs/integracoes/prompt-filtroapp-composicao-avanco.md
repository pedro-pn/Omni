# Pedido ao filtroAPP: composição do avanço por serviço para o Omni

> **Entregue em 24/11/2026** (filtroAPP `c7f32981`, catálogo `2026-11-24.1`, OpenAPI `1.16.0`) no formato abaixo, com
> o escopo `acompanhamento.progresso.read`. No Omni: migration 0074 (`mission_service_progress`), job
> `filtroapp-servicos` (de hora em hora, leitura completa que substitui a composição) e a seção
> "Composição do avanço" da aba Gestão.

> Escrito em 24/11/2026. A aba **Gestão** da missão no Omni já mostra, pelo filtroAPP,
> o avanço semana a semana e as metas (`/acompanhamento/projetos/semanas`), custo ×
> avanço (`/acompanhamento/projetos/custos`), equipe, horas, equipamento em obra,
> faturamento e desvios. O planejamento do Omni (Fase 9) prevê também a **composição
> do avanço por serviço** — o mesmo bloco "Composição do avanço · Avanço por serviço"
> do detalhe do projeto no filtroAPP (`ProjectDetailServiceComposition`).
> O Omni **não recalcula** avanço (regra do planejamento): precisa receber o número
> pronto, igual ao da tela do filtroAPP.

## O que pedimos

Um recurso novo de leitura, por projeto, com o mesmo cálculo da tela de detalhe:

`GET /acompanhamento/projetos/servicos` — escopo `acompanhamento.progresso.read` (ou um
próprio, ex.: `acompanhamento.servicos.read`), paginado como os outros recursos do
Acompanhamento (`updated_since`, `cursor`), uma linha por projeto:

```json
{
  "projectId": "…",
  "projectCode": "5850",
  "avancoTotal": 62.5,
  "servicos": [
    {
      "escopo": "Escopo 1",            // null quando o projeto não tem grupos de escopo
      "servico": "FLUSHING",            // serviceType
      "rotuloServico": "Flushing",
      "equipamento": "UH-01",           // null quando não há unidade (SISTEMA/MANGOTE) ligada
      "avancoPct": 80,                  // executionPct, o mesmo da tela
      "unidade": "M",                   // null quando os sistemas não somam (unidades diferentes)
      "rotuloUnidade": "m",
      "previsto": 120,                  // null quando não somam
      "realizado": 96,
      "sistemas": 3
    }
  ],
  "updatedAt": "2026-11-24T12:00:00Z"
}
```

- Os mesmos recortes da tela: serviços por grupo de escopo e, quando houver unidades
  ligadas, um item por equipamento (como os cartões da tela).
- Sem nomes de pessoas, notas ou textos livres.
- `avancoTotal` igual ao avanço do detalhe (o mesmo de `/acompanhamento/projetos/semanas`).

## O que o Omni faz com isso

- Mostra na aba Gestão da missão, para gerentes, diretoria e quem participa do Interno,
  os cartões por serviço (avanço, previsto × realizado na unidade física, excedente),
  com a data da última atualização do filtroAPP.
- A revisão semanal pode apontar o serviço que está segurando o avanço (sem calcular
  nada: só ordena pelo `avancoPct` recebido).

## Para conferir

- Projeto com grupos de escopo e com unidades ligadas a equipamento.
- Projeto sem composição calculada: `servicos: []` (a tela do Omni diz "Ainda não há
  composição de avanço no filtroAPP").
- Os números batem com o bloco "Composição do avanço" do detalhe do projeto.
