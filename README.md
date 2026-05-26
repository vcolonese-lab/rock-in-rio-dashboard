# Dashboard Primeira Classe Rock in Rio — Web Server

Dashboard de vendas com atualização automática, protegido por login e senha.

---

## Como funciona

1. O servidor Node.js hospedado no Railway busca dados direto da API da Ticketmaster.
2. Um **bookmarklet** (favorito do browser) sincroniza o token de autenticação com um clique.
3. Os dados se atualizam automaticamente a cada 5 minutos enquanto o token for válido (~12h).
4. Qualquer pessoa com login pode acessar o dashboard de qualquer dispositivo.

---

## Deploy no Railway (5 minutos)

### 1. Crie uma conta gratuita
Acesse [railway.app](https://railway.app) e faça login com GitHub.

### 2. Suba o código
```bash
# No terminal, dentro da pasta web-server:
npm install
git init
git add .
git commit -m "Rock in Rio Dashboard"
```

Depois no Railway:
- Clique em **New Project → Deploy from GitHub repo**
- Selecione o repositório
- Railway detecta automaticamente que é Node.js

### 3. Configure as variáveis de ambiente

No Railway, vá em **Variables** e adicione:

| Variável | Valor | Descrição |
|----------|-------|-----------|
| `USERS` | `vinicius:senha123,joao:outrasenha` | Usuários que podem acessar o dashboard |
| `ADMIN_KEY` | `minha-chave-secreta-2026` | Senha do bookmarklet (só você usa) |
| `SESSION_SECRET` | (string aleatória longa) | Ex: `xK9mP2qR8vL4nT7wY3aB6cF1jG5hD0` |

### 4. Aguarde o deploy
Em ~2 minutos o Railway mostrará a URL pública. Ex: `https://rock-in-rio-dashboard.up.railway.app`

---

## Configurar o bookmarklet (sincronização de token)

O bookmarklet é um favorito especial que, quando clicado no painel da Ticketmaster, envia o token de autenticação para o seu servidor. **Isso precisa ser feito uma vez a cada ~12 horas.**

### Criar o bookmarklet

1. No Chrome/Safari, adicione um novo favorito qualquer
2. Edite o favorito e substitua a URL por:

```javascript
javascript:(function(){var u=localStorage.getItem('u');if(!u){alert('Faça login na Ticketmaster primeiro');return;}var t=JSON.parse(u).authToken;fetch('https://SEU-APP.up.railway.app/admin/sync-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,adminKey:'SUA-ADMIN-KEY'})}).then(r=>r.json()).then(d=>alert(d.message||'OK!')).catch(e=>alert('Erro: '+e));})();
```

3. **Substitua:**
   - `SEU-APP.up.railway.app` pela URL do Railway
   - `SUA-ADMIN-KEY` pelo valor da variável `ADMIN_KEY`

4. Renomeie o favorito para: **"Sync RiR Dashboard"**

### Usar o bookmarklet

Sempre que o dashboard mostrar aviso de token expirando:
1. Abra [dashboard.ticketmaster.com.br](https://dashboard.ticketmaster.com.br) (já logado)
2. Clique no favorito **"Sync RiR Dashboard"**
3. Uma caixa de alerta confirma: *"Token sincronizado! Dados sendo atualizados..."*
4. Pronto — o dashboard se atualiza automaticamente nos próximos segundos

---

## Gerenciar usuários

Para adicionar/remover usuários, altere a variável `USERS` no Railway:
```
USERS = "vinicius:senha123,maria:outrasenha,pedro:senha456"
```
O servidor reinicia automaticamente com os novos usuários.

---

## Estrutura do projeto

```
web-server/
├── server.js      # Servidor Express completo (único arquivo)
├── package.json   # Dependências
└── README.md      # Este arquivo
```

---

## Variáveis de ambiente — referência completa

| Variável | Obrigatório | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `PORT` | Não | 3000 | Definido automaticamente pelo Railway |
| `USERS` | Sim | `vinicius:senha123` | Lista de usuários `user:pass,user2:pass2` |
| `ADMIN_KEY` | Sim | `mude-esta-chave` | Chave para o bookmarklet de sync |
| `SESSION_SECRET` | Sim | (aleatório) | Segredo de sessão — use uma string longa |
