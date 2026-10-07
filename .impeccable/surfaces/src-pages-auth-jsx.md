---
version: 1
slug: "src-pages-auth-jsx"
primary_target: "src/pages/Auth.jsx"
related_targets: ["src/pages/Dashboard.jsx","src/lib/api.js"]
---

# Surface: entrar e criar conta (/login, /cadastro)

Scope: telas de autenticação do VibeGet ligadas ao backend `server/` (contrato em PROGRESSO.md seção 7), mais o /dashboard provisório para onde o usuário vai depois de entrar. Mode: Operate.
Audience/job: comprador mobile, vindo da home, com Pix na mão; criar conta em segundos ou voltar à carteira. Action: Criar conta / Entrar.
Proof/content: bônus de GetCoin no cadastro, 40% de volta em GetCoin para quem não vence, produtos novos e lacrados. Não inventar valor de bônus (definido pelo admin, não é público).
Constraints (decididas com o usuário): cadastro curto (nome, e-mail, senha, aceite dos termos; CPF, celular e nascimento pedidos antes do 1º Get); cupom e indicação num campo recolhido "Tenho um cupom ou código de indicação", preenchido por ?cupom= / ?ref=; depois do acesso vai para um /dashboard provisório (nome, nível, saldo, sair). Access token só em memória; refresh por cookie com `X-Requested-With: fetch`.

## Direction contract

THESIS: A tela de acesso é o horizonte da home: a GetCoin nasce ao fundo e a conta é um painel de vidro ancorado nela. Recusa o card centralizado sobre fundo liso e o split 50/50 com foto de estoque.
OWN-WORLD: arte hero-bg (moeda âmbar no horizonte, brasa) em tela cheia; painel de vidro fosco de 32px com luz de brasa atrás; abas em pílula Entrar | Criar conta; campos em pílula de vidro com foco dourado; um único botão moeda por formulário; números em Martian Mono; erros em tinta clara com ícone, vermelho reservado ao que é ao vivo.
STORY: vê a moeda nascendo, lê em uma linha o que ganha ao entrar, preenche 3 campos, cria a conta e cai no dashboard com o saldo.
FIRST VIEWPORT: desktop: horizonte à esquerda (~58%), com título curto e a linha dos 40% sobre a arte; painel de vidro de ~440px à direita com abas, formulário e botão moeda. Celular: moeda visível no topo, painel sobe da base como folha.
FORM: Horizonte com painel de vidro, candidato 5 da lista, seed 3e6265de. Assinatura: a troca de aba desliza o indicador e o formulário muda de altura suavemente; no sucesso a moeda do horizonte sobe e brilha antes de ir para o dashboard.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
