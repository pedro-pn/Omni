# RIPD do Omni (rascunho para o encarregado)

> Rascunho técnico de 26/11/2026 (E15). Descreve o tratamento, os riscos e as medidas **como estão no
> código e na produção**. A análise jurídica, o teste de legítimo interesse e a assinatura são do
> **encarregado** (privacidade@filtrovali.com.br), com a aprovação da **diretoria**
> (art. 38; roteiro em `lgpd-ropa-dpa.md` §4). Os itens "a confirmar" dependem de quem não está no
> código.

## 1. Identificação

| Item | Conteúdo |
|---|---|
| Controlador | Filtrovali (Itajaí-SC) |
| Encarregado | privacidade@filtrovali.com.br |
| Sistema | Omni: comunicação das missões, e-mail, WhatsApp, tarefas e IA numa tela |
| Onde roda | VPS própria (Docker); banco Postgres no mesmo servidor; arquivos no SharePoint da Filtrovali |
| Operadores | Microsoft (M365, Entra, Graph), OpenAI (API, EUA), provedor da VPS; serviços de push dos navegadores (conteúdo cifrado de ponta a ponta) |
| Registro das operações | ROPA em `lgpd-ropa-dpa.md` §1 (uma linha por operação, com base legal e prazo) |

## 2. Operações que exigem o RIPD

Têm base em legítimo interesse e envolvem comunicação de pessoas:

| # | Operação | Por que é de maior risco |
|---|---|---|
| A | E-mails ligados a missões visíveis à diretoria e aos gerentes | Monitoramento de comunicação de trabalho; terceiros (clientes) nos e-mails |
| B | IA (OpenAI): leitura de RDOs, alertas, resumo de reuniões, assinatura dos e-mails, resumo de ligações gravadas | Envio de texto a operador fora do Brasil; decisões sugeridas por máquina |
| C | WhatsApp pelos números da empresa (Evolution, pareamento por QR) | Conversas com clientes; risco aceito de banimento (ADR 0004) |
| D | Gravação de ligações do WhatsApp | Voz de terceiros; guarda de 5 anos |
| E | Caixa única: cabeçalhos da caixa pessoal e agenda de contatos | Junta e-mail e telefone de terceiros |
| F | Alertas de risco (downloads em massa, arquivos enviados para fora) | Monitoramento do colaborador |

## 3. Necessidade e minimização (como está feito)

- **A:** só entram e-mails que se ligam a uma missão, pelo número, pela proposta, pela NF ou pelo
  domínio do cliente, este só quando há uma missão ativa. Ficam guardados só o cabeçalho, a prévia e
  o motivo da ligação, sem o corpo. A leitura completa é feita na hora no Microsoft 365, e cada
  abertura fica registrada (`app.abrir_email`). Quem vê: só diretoria e gerentes (`app.ve_emails`).
- **B:**
  - vai à OpenAI só o trecho necessário: o RDO, a mensagem dirigida à IA, a transcrição da reunião
    ligada à missão, o fim do e-mail mais recente de cada remetente;
  - a OpenAI está com **retenção zero** e `store: false`;
  - toda citação do modelo é conferida no texto original;
  - a IA só sugere: quem decide é uma pessoa;
  - há teto diário de uso (E11);
  - cada chamada é registrada sem o texto (`llm_calls`).
- **C:** só o dono do número vê as conversas, nem a Administração nem a diretoria (0054). O histórico
  anterior ao pareamento fica só no aparelho do dono. Mensagens internas nunca saem pelo WhatsApp.
- **D:** a gravação exige permissão por pessoa e o aviso aos participantes em cada ligação, e dá para
  pausar. O arquivo fica no SharePoint cifrado com uma chave por gravação, guardada só no Omni.
  Excluir apaga a chave na hora. O resumo pela IA só é feito quando o dono pede.
- **E:** os cabeçalhos ficam sem o corpo, e só o dono vê. Telefone e e-mail só se juntam por um
  vínculo conferido, nunca só pelo nome.
- **F:** os alertas contam downloads e envios para fora; o conteúdo não é lido. Só a Administração e a
  diretoria veem os alertas. O monitoramento está informado no termo de uso.

## 4. Riscos e medidas

| Risco | Prob. | Impacto | Medidas em vigor |
|---|---|---|---|
| Acesso indevido por outra pessoa da empresa | Baixa | Alto | Permissão no banco por pessoa e missão (RLS, papéis sem BYPASSRLS), testada no CI; liberação por módulo; login Microsoft (MFA: **a confirmar** no Entra) |
| Invasão pela internet | Baixa | Alto | HTTPS e HSTS; CSP com nonce (E12); conferência de origem contra CSRF (E16); limite de requisições (E10); rotas públicas listadas e testadas (E14); webhooks internos fechados no proxy; dependências auditadas no CI |
| Vazamento por operador fora do Brasil (OpenAI) | Baixa | Médio | Retenção zero, minimização, teto diário; DPA da OpenAI: **a confirmar assinatura** |
| Perda de dados | Baixa | Alto | Cópia local a cada 5 h; cópia cifrada no B2 diária (7 dias) e mensal (60 dias); ensaio de restauração automático todo mês (`backup.md`) |
| Guarda além do necessário | Média | Médio | Retenção por tipo de dado, técnicos e de negócio (`retencao.md`); hoje em ensaio, ligar `real` |
| Titular sem resposta | Média | Médio | Baixar meus dados (colaborador) e roteiro do encarregado (`titular.md`) |
| Erro ou abuso sem ninguém ver | Média | Médio | Erros do sistema e falhas de backup avisam o admin (E09); auditoria só de inserção |
| Banimento do número do WhatsApp | Média | Médio | Risco aceito (ADR 0004); interface trocável pela Cloud API; sem disparo em massa |

## 5. Teste de legítimo interesse (para o encarregado preencher)

Para cada operação de A a F:
1. **Finalidade legítima:** coordenar missões, atender o cliente, segurança da informação. Já
   descrita no ROPA.
2. **Necessidade:** o que está na seção 3 deste documento.
3. **Balanceamento:** expectativa do titular e impacto; para colaboradores, o comunicado e o termo.
4. **Salvaguardas:** seção 4.

Conclusão e assinatura: ______________________ Data: ____/____/______

## 6. Pendências para fechar o RIPD

- [ ] MFA obrigatório no Entra para quem entra no Omni (a confirmar).
- [ ] DPA da OpenAI assinado e confirmação da retenção zero guardada.
- [ ] DPA da Microsoft e do provedor da VPS anexados; residência de dados do tenant conferida.
- [ ] Comunicado ao time enviado com confirmação de leitura (`lgpd-ropa-dpa.md` §3).
- [ ] `RETENCAO=real` ligado na produção depois de conferir as contagens (`retencao.md`).
- [ ] Aviso de privacidade externo do site atualizado (WhatsApp, e-mail, IA).
