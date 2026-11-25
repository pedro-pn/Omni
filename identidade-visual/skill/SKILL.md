---
name: identidade-visual-filtrovali
description: Aplica a identidade visual da Filtrovali (cores, Poppins, logos, tom de voz e vocabulário de Missões) em qualquer sistema, tela, documento ou peça da empresa.
---

# Identidade visual Filtrovali

Use sempre que criar ou alterar algo da Filtrovali: sistemas internos (Prisma CRM, Foco, Central e novos), protótipos, páginas, apresentações, documentos e e-mails. Fonte oficial: brand book do Estúdio Molina (2024). Referência completa: `../design-system/README.md` e `../design-system/tokens.json`.

## A empresa
- Filtragem de óleo de máquinas (flushing, filtragem e diálise de óleo hidráulico, lubrificante e de turbina, análise ISO 4406). Fundada em 2005, Itajaí-SC.
- Assinatura: **Qualidade que move o seu futuro.**
- Tom de voz: confiante e humano. Palavras-chave: profissional, comprometida, experiente, sólida, confiável, especializada. Estilo: moderna, minimalista, humana.
- Público: gestores de manutenção, operações e compras da indústria (classe A/B, 35 a 60+).

## Vocabulário
- Projeto ganho = **Missão** com 4 dígitos; grupo "Missão 5712 - Cliente (detalhe)". Na interface, "Missões".
- Tarefas no padrão do Foco: `+pessoa`, `#projeto`, `hoje/amanhã/sexta/30/10`, `às 15h`, `p1`–`p4`.

## Cores
| Token | Hex | Uso |
|---|---|---|
| floresta | #30503A | Primária: logo, navegação, botão principal |
| nuvens | #E8E8E8 | Fundo padrão |
| azul | #11437E | Links, informação, e-mail |
| vermelho | #C81519 | Erro, alerta, gravação (pouco) |
| lilas | #9B93A8 | Decoração; nunca texto sobre branco |
| preto | #000000 | Capas |

Derivados de interface: floresta-escura #243d2c (hover), floresta-clara #e2eae4 (selecionado; escuro #22342a), floresta-texto #30503A (escuro #8fbf9d), superficie #fff (escuro #171b18), superficie-2 #f4f4f4, linha #dcdcdc, ink #1b211d, muted #5f6661.

## Tipografia
- **Poppins** 400/500/600/700 (Google Fonts). Títulos 600–700, texto 400–500 14px, legendas 12px, rótulos 11px caixa alta.
- Nunca escrever "Filtrovali" em Poppins no lugar do logo.

## Logo
- Símbolo: F de tubos com três setas em ciclo (azul, vermelha, lilás). Padrão (`color`) sobre fundo claro; invertido (`white`) sobre Floresta/preto. Respiro = altura do F; mínimo 24px. Arquivos em `../logos/`.

## Interface
- Navegação em Floresta com logo white; conteúdo em superfície sobre fundo; bordas 1px; cantos 6/10/16px; ícones de traço (estilo Lucide); sem emoji na interface; contraste 4.5:1; tema claro e escuro; funciona no celular.
