# Segurança

O Omni é o sistema interno de comunicação da Filtrovali. O código é público; os dados, as credenciais e a
infraestrutura não são.

## Como avisar uma falha

Não abra uma issue pública. Use o aviso privado do GitHub
(**Security → Report a vulnerability** neste repositório) com:

- o que encontrou e onde (arquivo, rota ou tela);
- como reproduzir;
- o impacto que imagina.

Respondemos em até 5 dias úteis. Pedimos que a falha não seja divulgada antes da correção.

## O que não fazer

- Testar contra `omni.filtrovali.com.br` ou qualquer endereço da Filtrovali. Rode o Omni localmente
  (README) para investigar.
- Acessar, copiar ou alterar dados de outras pessoas.

## Como o Omni se protege

- Permissão no banco: toda tabela com RLS e a aplicação sem `BYPASSRLS` (`packages/db/migrations`).
- Segredos só nas variáveis de cada ambiente, nunca no repositório (`.env.example` lista os nomes).
- Escrita nos outros sistemas em modo de ensaio fora da produção (CLAUDE.md, "Regras do código").
