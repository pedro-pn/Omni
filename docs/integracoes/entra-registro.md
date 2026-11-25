# Registro do Omni no Microsoft Entra ID (login)

> Precisa de alguém com papel **Administrador de Aplicativos** (ou Administrador Global) no tenant da Filtrovali.
> Este registro é **só para o login**. As permissões de Outlook, SharePoint e Teams (Fase 4) entram depois, num registro separado ("Omni – Integrações"), para manter o login com o mínimo de acesso.

## 1. Criar o registro
1. Acesse https://entra.microsoft.com → **Identidade → Aplicativos → Registros de aplicativo → Novo registro**.
2. **Nome:** `Omni`
3. **Tipos de conta com suporte:** *Contas somente neste diretório organizacional (Filtrovali – Locatário único)*.
4. **URI de redirecionamento:** plataforma **Web**, valor `http://localhost:3000/auth/callback`.
5. **Registrar.**
6. Na **Visão geral**, anote:
   - **ID do aplicativo (cliente)** → `ENTRA_CLIENT_ID`
   - **ID do diretório (locatário)** → `ENTRA_TENANT_ID`

## 2. Autenticação
1. Menu **Autenticação** → em **Web**, **Adicionar URI**: `https://omni.filtrovali.com.br/auth/callback`.
2. **Concessão implícita e fluxos híbridos:** deixe **tudo desmarcado** (o Omni usa código + PKCE).
3. **Permitir fluxos de cliente público:** **Não**.
4. **Salvar.**

## 3. Credencial
**Desenvolvimento (agora):**
1. **Certificados e segredos → Segredos do cliente → Novo segredo do cliente**.
2. Descrição `omni-dev`, validade **6 meses**.
3. Copie a coluna **Valor** (não o "ID do segredo") → `ENTRA_CLIENT_SECRET`. Ela só aparece uma vez.

**Produção (antes de publicar):** use certificado, não segredo.
```bash
openssl req -x509 -newkey rsa:3072 -sha256 -days 730 -nodes \
  -keyout omni-entra.key -out omni-entra.crt -subj "/CN=Omni Filtrovali"
openssl x509 -in omni-entra.crt -noout -fingerprint -sha256 | sed 's/.*=//; s/://g'   # → ENTRA_CERT_SHA256_THUMBPRINT
```
- Envie **só o `omni-entra.crt`** em **Certificados e segredos → Certificados → Carregar certificado**.
- O `omni-entra.key` fica só na VPS, em `deploy/secrets/` (fora do repositório e da imagem) → `ENTRA_PRIVATE_KEY_PATH=/run/secrets/omni/omni-entra.key` (caminho de dentro do contêiner). Permissões com Docker rootless: pasta `711`, chave `644` (`docs/producao/deploy.md` §3.3).
- Em produção, **apague o segredo `omni-dev`** ou não o use.

## 4. Permissões
1. **Permissões de API** → confira que existe **Microsoft Graph → Delegada → `User.Read`**.
2. **Adicionar uma permissão → Microsoft Graph → Permissões delegadas** → marque **`openid`**, **`profile`** e **`email`**.
3. **Conceder consentimento do administrador para Filtrovali.**

Não adicione nenhuma permissão de **aplicativo** neste registro.

## 5. Declaração de e-mail no token
1. **Configuração de token → Adicionar declaração opcional** → tipo **ID** → marque **`email`** → **Adicionar**.
2. Se perguntar, aceite ativar a permissão de e-mail do Microsoft Graph.

## 6. Quem pode entrar
1. **Identidade → Aplicativos → Aplicativos empresariais → Omni → Propriedades**:
   - **Atribuição obrigatória?** → **Sim** → **Salvar**.
2. **Usuários e grupos → Adicionar usuário/grupo**:
   - Por enquanto, só quem vai testar (você e o piloto).
   - Atribuir por **grupo** (ex.: `Omni - usuários`) exige Entra ID P1. Sem P1, atribua pessoa a pessoa.

## 7. MFA
- **Com Entra ID P1** (incluso no Microsoft 365 Business Premium): **Proteção → Acesso Condicional → Nova política** "Omni – exigir MFA":
  - **Usuários:** o grupo ou os usuários do Omni.
  - **Recursos de destino:** aplicativo **Omni**.
  - **Conceder:** *Exigir autenticação multifator*.
  - Ligue primeiro em **Somente relatório**, confira e depois **Ativado**.
- **Sem P1:** confirme que os **Padrões de segurança** do tenant estão ativos, porque eles já exigem MFA.

## 8. Ligar no Omni (desenvolvimento)
No arquivo `.env` da raiz do Omni (nunca versionado):
```
ENTRA_LOGIN_ENABLED=on
ENTRA_TENANT_ID=<ID do diretório>
ENTRA_CLIENT_ID=<ID do aplicativo>
ENTRA_CLIENT_SECRET=<Valor do segredo>
```
Depois: `npm run db:up`, `npm run dev` → http://localhost:3000 → **Entrar com a Microsoft**.

O primeiro login com a conta Microsoft se liga à pessoa que já existe com o mesmo e-mail, inclusive a criada pelo `db:seed-dev`, e mantém os perfis dela.

Em produção, as mesmas variáveis vão em `deploy/.env.production`, com `ENTRA_PRIVATE_KEY_PATH` e `ENTRA_CERT_SHA256_THUMBPRINT` no lugar de `ENTRA_CLIENT_SECRET`.
