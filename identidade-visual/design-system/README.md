# Filtrovali

Identidade visual da Filtrovali, empresa de filtragem de óleo de máquinas fundada em 2005. Este sistema resume o brand book do Estúdio Molina (2024) e acrescenta o que é preciso para usar a marca em sistemas internos (Prisma, Foco, Central e os próximos).

**Assinatura:** Qualidade que move o seu futuro.

## Fundamentos de conteúdo

- **Tom de voz:** confiante e humano. Fala como um parceiro técnico de longa data, nunca como vendedor.
- **Palavras-chave da marca:** profissional, comprometida, experiente, sólida, confiável, especializada.
- **Aspectos visuais:** moderna, minimalista, humana.
- **Público:** classe A/B, 35 a 60+ anos, predominantemente masculino. São gestores de manutenção, operações e compras da indústria.
- **Vocabulário interno:** um projeto ganho vira uma **Missão** com número de 4 dígitos. O grupo de WhatsApp segue o padrão `Missão 5712 - Cliente (detalhe)`. Oportunidades no Prisma usam o código `OP-AAAA-NNNN`.
- **Escrita em sistemas:** frases curtas, verbos de ação nos botões ("Concluir", "Enviar proposta"). Números técnicos reais quando houver, como vazão em L/min ou limpeza do óleo em ISO 4406 (`16/14/11`).

> Manifesto (trecho): "Na Filtrovali acreditamos que a qualidade é um compromisso inegociável. Desde 2005, nos dedicamos a oferecer soluções eficazes para filtragem de óleo, sempre buscando o melhor desempenho para nossos clientes."

## Fundamentos visuais

### Cores

| Token | Hex | Papel |
|---|---|---|
| `floresta` | #30503A | Primária. Logo, navegação, botões principais, fundo invertido |
| `nuvens` | #E8E8E8 | Primária neutra. Fundo padrão |
| `azul` | #11437E | Secundária. Links, informação, e-mail |
| `vermelho` | #C81519 | Secundária. Alerta, erro, gravação. Usar pouco |
| `lilas` | #9B93A8 | Secundária. Só decoração e gráficos, nunca texto |
| `preto` | #000000 | Secundária. Capas e apresentações |

- A marca se apoia em **Floresta + Nuvens**. As secundárias vêm das três setas do símbolo e aparecem em detalhes.
- Os tokens `floresta-escura`, `floresta-clara`, `floresta-texto`, `fundo`, `superficie`, `superficie-2`, `linha`, `ink` e `muted` são derivados para interface. Eles não estão no brand book.
- No tema escuro, a navegação continua em `floresta`, e os textos de destaque usam `floresta-texto`.
- Os mockups do brand book mostram um verde mais vivo, mas o oficial é o `floresta` #30503A.

### Tipografia

- **Poppins** é a fonte de apoio oficial (Google Fonts). Use SemiBold ou Bold em títulos e Regular ou Medium em parágrafos.
- O logotipo usa um desenho próprio, com detalhes curvilíneos. **Nunca** escreva "Filtrovali" em Poppins no lugar do logo: use o arquivo.
- Em sistemas, a IBM Plex Mono é aceitável para códigos e números alinhados (`codigo`), mas ela não faz parte da marca.

### Forma e espaço

- O visual é limpo e minimalista: superfícies brancas sobre Nuvens, bordas de 1px (`linha`) e sombras raras.
- Use cantos moderados: `raio-md` (10px) em botões e campos e `raio-lg` (16px) em cartões. Não arredonde tudo.
- O motivo gráfico são os **arcos com seta**, um ciclo de três cores. Nas peças do brand book ele aparece como arcos grandes saindo das bordas.

## Logotipo e símbolo

- **Símbolo:** a letra F construída com tubos, cercada por três setas em ciclo (azul, vermelha e lilás), que representam reciclagem e sustentabilidade.
- **Composição horizontal:** para espaços mais largos que altos, como cabeçalhos, e-mails e barras.
- **Composição vertical:** para espaços mais altos que largos, como capas, crachás e telas de login.
- **Aplicação padrão:** fundo claro (Nuvens ou branco) com o logo nas cores principais (arquivo `color`).
- **Aplicação invertida:** fundo Floresta ou preto com o logo invertido (arquivo `white`: F e letras brancas, setas coloridas).
- **Área de respiro:** a altura da própria letra F em todos os lados.
- **Não fazer:** girar ou deformar o símbolo, separar as setas, aplicar o logo sobre fundo com pouco contraste, usar o símbolo pequeno demais (mínimo de 24px em tela) ou recriar o logo com fonte.

## Iconografia

Use ícones de traço em linha (estilo Lucide, traço de 1.9 a 2px, cantos arredondados) na cor `ink` ou `muted`, e em `floresta-texto` quando ativos. Não use emoji em interface. Ícones de app de módulos internos podem seguir o padrão do Foco: as três setas do símbolo em volta de um glifo do módulo em Floresta (veja `exemplo-icone-foco.png`).

## Como usar em um sistema novo

1. Carregue a Poppins (400, 500, 600 e 700) pelo Google Fonts.
2. Declare as cores como variáveis CSS com os nomes dos tokens, com o tema claro no `:root` e o escuro em `prefers-color-scheme: dark`.
3. Navegação lateral ou barra superior em `floresta` com o logo `white`, conteúdo em `superficie` sobre `fundo`.
4. Botão principal em `floresta` com texto branco, hover em `floresta-escura`. Item selecionado em `floresta-clara`.
5. Links e informação em `azul`, erros e gravações em `vermelho`.
6. Logos: use os arquivos do grupo **Logos**, nunca uma recriação.
