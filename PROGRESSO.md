# PROGRESSO — Backend VibeGet

> **Para qualquer IA ou pessoa que continuar este trabalho:** leia este arquivo inteiro antes de mexer no código.
> Ele é a fonte da verdade sobre decisões, contrato da API, estado atual e próximos passos.
> **Ao terminar qualquer sessão de trabalho, atualize as seções "Estado atual", "Log de sessões" e "Próximos passos".**

Contexto do produto: veja [PRODUCT.md](PRODUCT.md) (vocabulário: Vibe = leilão, Get = lance, Champion Get = lance vencedor, Viber = quem já venceu, GetCoin = saldo de cashback).

---

## 1. Objetivo desta fase

Criar o backend que vai sustentar as telas **/login**, **/cadastro** e **/dashboard** (usuário e admin), cobrindo:
autenticação, níveis de usuário, permissões, API REST, gerenciamento de dados (usuários, carteira GetCoin, produtos, Vibes, Gets, pagamentos), segurança e testes.

Fora de escopo desta fase: integração real com gateway Pix/cartão (fica um provedor *mock* com a mesma interface), envio real de e-mail (fica um *mailer* de console), telas do front.

## 2. Fluxo de trabalho com dois agentes

| Agente | Papel | Pode editar |
| --- | --- | --- |
| **Criação (builder)** | Implementa o backend conforme este documento | `server/**`, `PROGRESSO.md` |
| **Validação (QA)** | Revisa arquitetura/segurança, escreve e roda testes, reporta falhas | `server/tests/**`, `PROGRESSO.md` (seção 9) |

Ciclo: builder implementa → QA valida e registra achados na seção 9 → builder corrige → QA reverifica. Um item só vai para "feito" quando o QA confirmar com teste passando.

## 3. Decisões de arquitetura (ADR resumido)

| Decisão | Escolha | Motivo |
| --- | --- | --- |
| Local do código | `server/` na raiz, `package.json` próprio | Front (Vite) e back independentes; o front usa proxy `/api` no dev |
| Linguagem | TypeScript estrito (Node 24, ESM) | Segurança de tipos em regras de dinheiro |
| Framework HTTP | Fastify 5 | Rápido, validação e plugins de segurança maduros, `inject()` para testes sem porta |
| Banco | PostgreSQL | Transações e locks para lances e saldo |
| Banco em dev/teste | **PGlite** (Postgres em WASM, embutido) quando `DATABASE_URL` não está definido | Roda sem Docker/instalação; mesmo dialeto do prod |
| ORM / migrações | Drizzle ORM + drizzle-kit | Suporta PGlite e node-postgres com o mesmo schema |
| Validação | Zod (schemas `.strict()`, rejeita campos desconhecidos) | Evita mass assignment |
| Hash de senha | Argon2id (`@node-rs/argon2`, binário pré-compilado) | Padrão OWASP |
| Sessão | Access token JWT (15 min, no corpo da resposta, guardado em memória no front) + refresh token opaco (30 dias) em cookie `httpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` com **rotação e detecção de reuso** | Sem token em localStorage; reuso de refresh revoga a família inteira |
| Dinheiro | Inteiros em **centavos** (`bigint`/`integer`), nunca float. GetCoin 1:1 com centavo de R$ | Sem erro de arredondamento |
| Carteira | Livro-razão (`getcoin_ledger`) imutável + saldo em cache em `wallets` atualizado na mesma transação com `SELECT ... FOR UPDATE` | Auditável e sem saldo negativo por corrida |
| Testes | Vitest + `app.inject()` + PGlite em memória por suíte | Rápido e isolado |
| Logs | pino com `redact` de senha, token, cookie, authorization | Nada sensível em log |

**Desvios / complementos registrados pelo builder (2026-09-25):**

| Item | O que foi feito | Motivo |
| --- | --- | --- |
| Colunas extras | `getcoin_ledger.balance_after_cents`, `users.deleted_at`, `payments.expires_at` | Extrato com saldo por linha; data da anonimização; expiração do Pix mock |
| Livro-razão imutável no banco | Migração custom `0001_ledger_immutable.sql` (trigger bloqueia UPDATE/DELETE) | Garantia além da aplicação |
| Access token revogável | JWT leva `sid` = `family_id`; `authenticate` confere no banco se a sessão está ativa e se o usuário está `ACTIVE`; a role efetiva vem do banco | Logout, logout-all, troca/reset de senha, suspensão e mudança de role valem na hora, não em 15 min |
| CSRF | Header `X-Requested-With: fetch` obrigatório em register/login/refresh/logout/logout-all/PATCH password. Origin, se enviada, precisa estar em `CORS_ORIGINS`; **ausente é aceita só com `NODE_ENV=development|test`** (curl/testes) e recusada em produção ou sem NODE_ENV (QA-05) | Chamadas sem navegador em dev |
| Cadastro duplicado | `409 ACCOUNT_EXISTS` com mensagem única para e-mail **ou** CPF | A spec não definia; enumeração limitada por rate limit (10/h por IP) |
| Conta bloqueada | Login responde o mesmo `401 INVALID_CREDENTIALS` (mensagem cita o bloqueio de 15 min) | Não revela se a conta existe |
| Conta suspensa | `403 ACCOUNT_SUSPENDED` só depois que a senha confere | Não permite enumeração sem senha |
| `resend-verification` | Exige login (Bearer) | Evita enumeração por e-mail |
| Bônus de indicação | `REFERRAL_BONUS_CENTS` (padrão 0) é creditado ao indicador quando o indicado **confirma o e-mail** | A spec não definia o gatilho; reduz abuso com contas falsas |
| Idempotency-Key | Mesma chave com dados diferentes → `409 IDEMPOTENCY_KEY_REUSED`; repetição idêntica → `200` com o mesmo Get (criação é `201`) | Padrão de mercado |
| Pagamento após encerramento | Pago depois de a Vibe encerrar/cancelar → pagamento e Get `REFUNDED`, GetCoin devolvido | Get não pode entrar numa disputa encerrada |
| Cancelamento de Vibe | `PATCH /admin/vibes/:id {status:'CANCELLED'}`: pendentes `FAILED`, confirmados `REFUNDED`, GetCoin devolvido, sem cashback | A spec previa o status sem a regra |
| Edição de Vibe LIVE | Só `endsAt`, `goalGets` ou cancelar; duração máxima de 15 dias; `ENDED`/`CANCELLED` imutáveis | Não mudar regras de dinheiro com a disputa em andamento |
| `goal_gets` | Só informativo; **não** encerra a Vibe automaticamente | Regra 6 não prevê; aguardar o cliente |
| Rota extra | `GET /admin/gets` (SUPPORT/ADMIN, com pagamento) | Seção 4 dá a SUPPORT leitura de Gets/pagamentos, mas a seção 7 não tinha rota |
| Jobs | `src/jobs/index.ts`: ativa SCHEDULED, expira pagamentos pendentes (`PAYMENT_TTL_MINUTES`) e encerra Vibes vencidas a cada `JOBS_INTERVAL_MS` | Settlement reutilizável, conforme 6.5 |
| Auto-migrate no dev | Com PGlite, `npm run dev` aplica as migrações no boot (`AUTO_MIGRATE`) | O diretório do PGlite não pode ser aberto por 2 processos |
| Preços estimados no seed _(D5: agora só no seed de demonstração; produtos fictícios)_ | MacBook Pro M3 14" (R$ 16.999), Xiaomi 14 Pro (R$ 6.499), Dell XPS 15 (R$ 13.999), ThinkPad X1 Carbon (R$ 12.999) | `data.js` não traz preço deles; a descrição do produto diz "estimado — confirmar com o cliente" |

**Decisões do builder na rodada D1–D5 (2026-09-25):**

| Item | O que foi feito | Motivo |
| --- | --- | --- |
| D1 — prazo gravado no pagamento | `payments.expires_at = min(agora + TTL, ends_at - cutoff + grace)` na criação do Get. PAID **depois de `expires_at`** é estornado mesmo que o job ainda não tenha vencido a cobrança | Resultado determinístico; mudar as configurações depois não altera Gets já criados |
| D1 — encerramento | O job continua encerrando só em `ends_at` (nunca antes). `POST /admin/vibes/:id/close` segue permitindo encerramento **antecipado manual** pelo ADMIN (comportamento anterior, coberto por testes) | "Não encerrar antes de ends_at" aplicado ao automático; o manual é decisão explícita do ADMIN |
| D1 — front | `GET /vibes` e `/vibes/:slug` passam a trazer `getsCloseAt` (= `ends_at - get_cutoff_seconds`) | O front desabilita o botão de Get no minuto final |
| D3 — settings | Tabela `settings` (chave → JSON) validada inteira por Zod (`lib/settings.ts`); chave ausente usa o valor do env; cache em memória de 30 s invalidado no PATCH da instância; PATCH serializado com advisory lock; audit `SETTINGS_UPDATED` com de → para | Com várias instâncias a mudança chega às outras em até 30 s |
| D3 — limites | bônus 0–100.000 centavos (R$ 1.000); `getCutoffSeconds` 0–3600; `paymentGraceSeconds` 0–cutoff; `defaultCashbackPercent` 0–100. GET e PATCH só ADMIN | Evitar erro de digitação e prazo de pagamento depois do fim |
| D3 — leitura fora de transação | Configurações são lidas **antes** de abrir transações | Ler fora da transação com ela aberta trava o PGlite (1 conexão) |
| D4 — resposta genérica | Inexistente, inativo, fora da validade, esgotado, limite por usuário, conta não nova ou formato inválido → sempre `422 COUPON_UNAVAILABLE` "Cupom inválido ou indisponível."; o motivo real vai só para o audit (`COUPON_REDEEM_FAILED`) | Não permite descobrir códigos |
| D4 — limite por usuário no banco | `coupon_redemptions.seq` (n-ésimo resgate do usuário) + `UNIQUE(coupon_id, user_id, seq)`; com limite 1 equivale a `UNIQUE(coupon_id, user_id)` | Garante o limite mesmo em corrida |
| D4 — "só contas novas" | Conta criada **depois da criação do cupom** | O cliente não definiu; regra simples e auditável |
| D4 — cupom no cadastro | `couponCode` não é validado no schema do cadastro; o resgate roda **depois** do commit do usuário. Inválido → cadastro 201 com `couponApplied:false`; válido → `couponApplied:true`. O campo só aparece quando `couponCode` foi enviado | Cupom nunca derruba o cadastro |
| D4 — edição | Valor e "só contas novas" congelam após o 1º resgate (409 `COUPON_LOCKED`); `maxRedemptions` não pode ficar abaixo do já resgatado; teto de R$ 1.000 por cupom; SUPPORT lê cupons/resgates, só ADMIN escreve | Consistência contábil |
| D5 — upload | `@fastify/multipart` (1 arquivo, `UPLOAD_MAX_BYTES`); tipo pelos magic bytes (JPEG/PNG/WebP; SVG nunca); **reprocessada com sharp** (decodifica, aplica rotação, reduz para no máx. 2400 px, re-encoda sem EXIF/GPS/XMP; limite de 40 MP contra decompression bomb); nome `<uuid>.<ext>` gerado pelo servidor; audit `IMAGE_UPLOADED` | Arquivo poliglota ou corrompido falha na decodificação |
| D5 — servir | `GET /uploads/:name` (fora de `/api/v1`, sem auth); só aceita nome no formato gerado (senão 404, sem path traversal); headers `Content-Type` correto, `nosniff`, `CSP default-src 'none'; sandbox`, `CORP cross-origin`, cache imutável. Proxy `/uploads` adicionado no `vite.config.js` | O front usa `imageUrl = /uploads/...` |
| D5 — leilão | `POST /admin/auctions { product, vibe }` numa transação (slug repetido da Vibe desfaz o produto); audit `PRODUCT_CREATED` + `VIBE_CREATED` + `AUCTION_CREATED` | Tela "cadastro de leilão" |
| D5 — seed | `npm run db:seed` = admin + configurações iniciais. `npm run db:seed:demo` (ou `db:seed -- --demo`) = também os 8 produtos **fictícios** e as Vibes de exemplo; recusado quando o env é de produção | Produtos reais vêm do dashboard |
| Dependências novas | `@fastify/multipart`, `sharp` (binário pré-compilado, sem script de instalação) | Upload e reprocessamento |

**Decisões e desvios do builder na rodada D6–D9 (2026-09-25):**

| Item | O que foi feito | Motivo |
| --- | --- | --- |
| **Desvio — chaves de saque nas configurações** | As chaves ficam no mesmo armazenamento (`settings`) e são auditadas igual, mas com nomes camelCase `withdrawMinCents` e `withdrawDailyMaxCents` (a spec dizia `withdraw_min_cents`/`withdraw_daily_max_cents`) e expostas num **grupo separado**: `GET /admin/settings/withdrawals` → `{ "data": { "withdrawMinCents": 1000, "withdrawDailyMaxCents": 500000 } }` e `PATCH /admin/settings/withdrawals` (mesmo formato, parcial). `GET/PATCH /admin/settings` continua devolvendo **só as 5 chaves da D3** | O teste do QA `GET devolve os 5 valores` usa igualdade exata; camelCase segue as chaves já existentes |
| Tipo extra no `cash_ledger` | `REFUND` (estorno de Get pago com saldo quando a Vibe é cancelada) | A lista da D6 não tinha tipo para "estorno para o saldo" |
| Provedor `INTERNAL` | Pagamento com método `BALANCE` grava `provider = INTERNAL`, `status = PAID`, `paid_at = expires_at = agora`, `external_id = bal_<aleatório>` | Sem provedor externo; o `simulate`/webhook sobre ele não muda nada (já PAID) |
| Ordem de locks global | Vibe → pagamento/Get/compra/saque → **carteiras GetCoin** (em ordem de `user_id`) → **carteiras R$** (em ordem de `user_id`). Settlement/cancelamento travam todas as carteiras GetCoin e depois todas as R$ dos usuários da Vibe no início (`lockWalletsOfVibe` + `lockCashWallets`) | Evita deadlock entre Gets pagos com saldo, compras e encerramentos |
| Carteira R$ criada sob demanda | `applyCashMovement` faz `INSERT … ON CONFLICT DO NOTHING` antes do `FOR UPDATE` | Usuários antigos (e os criados pelos testes) não têm linha em `cash_wallets` |
| Compra exige e-mail verificado | `POST /me/getcoin-purchases` → `403 EMAIL_NOT_VERIFIED` sem e-mail confirmado | Movimenta dinheiro, como o Get |
| Saque | Exige e-mail verificado e CPF; valida a chave por tipo (CPF com dígitos; e-mail; telefone vira `+55…`; aleatória = UUID) e guarda **normalizada**. Limite diário = soma dos saques `PENDING`+`PAID` nas **últimas 24 h** (janela móvel), calculada **depois** de travar a carteira R$ (pedidos paralelos do mesmo usuário são serializados). ADMIN não decide o próprio saque (403). Aprovar exige corpo vazio; recusar exige `reason` (5–500) | Anti-fraude e corrida |
| Chave Pix | Dono e SUPPORT só veem `pixKeyMasked`; o **ADMIN** vê também `pixKey` completa em `GET /admin/withdrawals` (precisa para pagar). Audit guarda só a mascarada. `*.pixKey` entrou no redact do log | Dado pessoal |
| Exclusão LGPD | `DELETE /me` responde `409 CASH_BALANCE` se houver saldo em R$ ou saque pendente (dinheiro do usuário não some); na exclusão, o endereço é apagado e a chave Pix dos saques antigos fica só mascarada. `/me/export` inclui `cash`, `withdrawals` (mascarados) e `getcoinPurchases` | LGPD sem perder dinheiro |
| Pacotes | Compra guarda **snapshot** (nome, getcoins, bônus, preço); editar o pacote não muda compras antigas. `DELETE` só para pacote nunca comprado (`409 PACKAGE_IN_USE`; desative com `active:false`) | Integridade contábil |
| CEP | `GET /cep/:cep` aceita com ou sem hífen; ViaCEP (timeout 3 s) → BrasilAPI; cache em memória 24 h para encontrados e 1 h para inexistentes (máx. 5000 entradas); `503 CEP_UNAVAILABLE` se os dois falharem; rate limit 30/min por IP. HTTP de saída injetável (`buildApp({ fetch })`) para testes | Sem rede nos testes |
| Meus Gets | "Vencendo" (`isLeading`/`leading`) usa a mesma regra do encerramento: maior total confirmado, empate → mais antigo. `lost` = Vibes `ENDED` com Get confirmado do usuário e vencedor diferente (ou sem vencedor) | Consistência com D2/6.5 |
| Saldo R$ | Não há rota de ajuste manual de saldo em R$ nesta fase (o tipo `ADJUSTMENT` existe no livro-razão) | Não foi pedido; fica para quando houver necessidade |

**Decisões e desvios do builder na rodada D11–D12 (2026-09-28):**

| Item | O que foi feito | Motivo |
| --- | --- | --- |
| **Desvio — nomes dos lançamentos em R$ do vendedor** | Usados os tipos que já existiam no `cash_ledger` desde a D6: `MARKETPLACE_SALE` (+ bruto) e `MARKETPLACE_FEE` (− taxa). A seção 6.3 escreve `MARKET_SALE`/`MARKET_FEE` | Evitar dois nomes para a mesma coisa no enum |
| Débito do comprador que paga com saldo | `cash_ledger` tipo `GETCOIN_PURCHASE` com `referenceType = "market_order"` | É uma compra de GetCoin; o `referenceType` distingue de pacote/avulsa |
| Configurações | `GET/PATCH /admin/settings/getcoin` e `/admin/settings/market` (mesmo armazenamento e audit; `/admin/settings` continua com as 5 chaves da D3). Faixas: unitário 1–100.000; mín./máx. avulsa e mínimo de anúncio em GetCoins inteiros (múltiplos de 100) de 100 a 100.000.000; `marketFeePercent` 0–50; mín. ≤ máx. validado | Padrão de `/admin/settings/withdrawals` |
| Compra avulsa | `package` na resposta é sempre objeto: `{ "id": null, "name": "Avulso", "getcoinsCents", "bonusCents": 0, "priceCents" }`. Repetição com a mesma `Idempotency-Key` compara `customGetcoinsCents` e `method` | Um só formato para o front |
| "Reservado" no anúncio | `remaining` = disponível para novos pedidos (pedidos pendentes já saíram dele). `reservedCents` = Σ pedidos `PENDING_PAYMENT`; `soldCents` = Σ pedidos `PAID` | Sem vender além do disponível sob concorrência (lock no anúncio) |
| `SOLD_OUT` | Só quando `remaining = 0` **e** não há pedido pendente; enquanto houver pendente o anúncio segue `ACTIVE` (fora da lista pública, porque `remaining = 0`). Pedido que falha devolve a quantidade ao anúncio `ACTIVE`; se o anúncio estiver `CANCELLED`, devolve ao vendedor (`MARKET_ESCROW_RETURN`) | Evita "esgotado" que depois reabre |
| Conservação de GetCoin | Σ carteiras + Σ `remaining` dos anúncios + Σ GetCoin dos pedidos `PENDING_PAYMENT` é constante (verificado em teste de sanidade) | Custódia auditável |
| Ordem de locks | anúncio → pagamento → pedido → carteira GetCoin do comprador → carteiras R$ em ordem de `user_id` (comprador com saldo e vendedor) | Mesma política global |
| PAID tardio de pedido | Sobre pagamento `FAILED`: estorna o dinheiro (quantidade já tinha voltado). Pendente mas depois do `expires_at`: estorna **e** libera a quantidade. Pedido fica `REFUNDED` | Padrão QA-01 |
| Privacidade | Público vê o vendedor só por `publicName` ("Pedro A."); `/me/market/sales` não traz nada do comprador; `/me/market/orders/:id` de outro usuário = 404 | Nenhum dado de outro usuário |
| Admin | `GET /admin/market/listings` e `/admin/market/orders` para SUPPORT e ADMIN; cancelar anúncio só ADMIN (audit `MARKET_LISTING_CANCELLED_BY_ADMIN`). `/admin/dashboard` ganhou `market: { feeRevenueCents, paidOrders }`, e `revenue.confirmedCents` **deixou de somar pagamentos de pedidos do marketplace** (esse dinheiro é do vendedor) | Receita da plataforma = taxas |
| LGPD | `DELETE /me` responde `409 MARKET_OPEN` com anúncio ativo ou pedido pendente (como comprador ou vendedor); `/me/export` inclui `market.listings` e `market.orders` (com `role`) | Não deixar GetCoin em custódia órfão |
| Migração no banco de dev | A `0008_market.sql` **não foi aplicada** no `server/.data/pglite`: a API de dev estava rodando (PID 18144/30604) e a regra é não abrir o PGlite em dois processos nem matar o processo. Validei aplicando numa **cópia** do banco de dev. Ao reiniciar a API (`AUTO_MIGRATE`), ou com a API parada rodando `npm run db:migrate`, a 0008 é aplicada | Evitar corromper o banco de dev |

## 4. Níveis e permissões

Dois eixos separados:

**Papel (role) — controla permissão:**

| Role | Pode |
| --- | --- |
| `USER` | Próprio perfil, própria carteira, dar Gets, ver Vibes, próprio dashboard, exportar/excluir os próprios dados |
| `SUPPORT` | Tudo de USER + ler usuários, ler Gets/Vibes/pagamentos, ler audit log. **Não** altera saldo, role nem Vibes |
| `ADMIN` | Tudo + CRUD de produtos e Vibes, encerrar Vibe, ajustar GetCoin (com motivo obrigatório), mudar role/status de usuários, dashboard admin |

Regras: ninguém muda a própria role; só ADMIN promove; o último ADMIN ativo não pode ser rebaixado/suspenso. Toda ação administrativa gera `audit_logs`.

**Nível (level) — gamificação, vem do produto:**

- `EXPLORADOR` (Nível 1): atribuído no cadastro, recebe bônus de boas-vindas em GetCoin (valor em env `WELCOME_BONUS_CENTS`, padrão 0 até o cliente definir).
- `VIBER` (Nível 2): promovido automaticamente ao ter o primeiro Champion Get.

**Status da conta:** `ACTIVE`, `SUSPENDED` (não loga, sessões revogadas), `DELETED` (anonimizada, LGPD).

## 5. Modelo de dados

Todas as tabelas com `id uuid` (gerado no app), `created_at`, `updated_at` quando fizer sentido.

- **users**: name, email (único, minúsculo), cpf (único, 11 dígitos validados, opcional no cadastro, obrigatório para dar Get), phone, birth_date (maior de 18 para dar Get), password_hash, role, level, status, email_verified_at, failed_login_count, locked_until, referral_code (único), referred_by_id, terms_accepted_at, terms_version, marketing_opt_in.
- **sessions** (refresh tokens): user_id, token_hash (SHA-256), family_id, expires_at, revoked_at, replaced_by_id, user_agent, ip.
- **auth_tokens**: user_id, type (`EMAIL_VERIFY`, `PASSWORD_RESET`), token_hash, expires_at, used_at.
- **wallets**: user_id (PK), balance_cents (>= 0, CHECK).
- **getcoin_ledger**: user_id, amount_cents (com sinal), type (`WELCOME_BONUS`, `CASHBACK`, `SPEND_ON_GET`, `REFUND`, `REFERRAL`, `ADJUSTMENT`), reference_type, reference_id, reason, created_by_id. Imutável.
- **products**: slug (único), name, category (`smartphones|notebooks|games|audio|wearables`), image_url, original_price_cents, description.
- **vibes**: product_id, slug (único), status (`DRAFT`, `SCHEDULED`, `LIVE`, `ENDED`, `CANCELLED`), min_get_cents, starts_at, ends_at, goal_gets, cashback_percent (padrão 40), winner_get_id, settled_at.
- **gets**: vibe_id, user_id, cash_cents, getcoin_cents, total_cents, status (`PENDING_PAYMENT`, `CONFIRMED`, `FAILED`, `REFUNDED`), idempotency_key (único por usuário).
- **payments**: get_id, provider (`MOCK`), method (`PIX`, `CARD`), status (`PENDING`, `PAID`, `FAILED`, `REFUNDED`), amount_cents, external_id, pix_copy_paste, paid_at.
- **audit_logs**: actor_id, action, entity, entity_id, metadata jsonb, ip, created_at.
- _(D3)_ **settings**: key (PK), value jsonb, updated_by_id, updated_at. Chaves: `welcomeBonusCents`, `referralBonusCents`, `getCutoffSeconds`, `paymentGraceSeconds`, `defaultCashbackPercent`.
- _(D4)_ **coupons**: code (único, MAIÚSCULAS, CHECK), amount_cents (> 0), max_redemptions (null = ilimitado), per_user_limit (padrão 1), redemptions_count (CHECK <= max), starts_at, ends_at, active, new_accounts_only, description, created_by_id.
- _(D4)_ **coupon_redemptions**: coupon_id, user_id, seq, amount_cents, ledger_id, created_at; `UNIQUE(coupon_id, user_id, seq)`.
- _(D6)_ **cash_wallets**: user_id (PK), balance_cents (CHECK >= 0). **cash_ledger** (imutável: triggers de UPDATE/DELETE/TRUNCATE, migração `0006`): user_id, amount_cents (≠ 0), balance_after_cents, type (`GET_PAYMENT`, `GETCOIN_PURCHASE`, `WITHDRAWAL`, `WITHDRAWAL_REVERSAL`, `ADJUSTMENT`, `REFUND`, `MARKETPLACE_SALE`, `MARKETPLACE_FEE`), reference_type/id, reason, created_by_id, seq (identity), created_at.
- _(D6)_ **withdrawals**: user_id, amount_cents (> 0), pix_key_type (`CPF|EMAIL|PHONE|RANDOM`), pix_key (normalizada), status (`PENDING|PAID|REJECTED`), idempotency_key (`UNIQUE(user_id, idempotency_key)`), decided_by_id, decided_at, reject_reason.
- _(D7)_ **getcoin_packages**: name, getcoins_cents (> 0), bonus_cents (>= 0), price_cents (> 0), active, sort_order. **getcoin_purchases**: user_id, package_id, snapshot (package_name, getcoins_cents, bonus_cents, price_cents), method, status (`PENDING_PAYMENT|PAID|FAILED|REFUNDED`), idempotency_key (`UNIQUE(user_id, idempotency_key)`).
- _(D7)_ **payments**: `get_id` virou opcional e entrou `purchase_id`; CHECK `payments_one_target_ck` exige exatamente um; `UNIQUE(purchase_id)`. `method` ganhou `BALANCE`; `provider` ganhou `INTERNAL`. **getcoin_ledger.type** ganhou `PURCHASE` e `PURCHASE_BONUS`.
- _(D8)_ **users**: cep (8 dígitos), street, number, complement, district, city, state (UF) — todos opcionais.
- Migrações da rodada: `0005_cash_purchases_address.sql` e `0006_cash_ledger_immutable.sql` (nenhuma antiga editada).
- _(D12)_ **market_listings**: seller_id, unit_price_cents (> 0), total_cents (> 0, múltiplo de 100), remaining_cents (0..total, múltiplo de 100), status (`ACTIVE|SOLD_OUT|CANCELLED`). **market_orders**: listing_id, buyer_id, seller_id (CHECK comprador ≠ vendedor), getcoins_cents (múltiplo de 100), unit_price_cents, total_price_cents (CHECK = GetCoins/100 × unitário), fee_cents + seller_net_cents = total (CHECK), method, status (`PENDING_PAYMENT|PAID|FAILED|REFUNDED`), idempotency_key (`UNIQUE(buyer_id, idempotency_key)`).
- _(D12)_ **payments.order_id** (UNIQUE) e novo `payments_one_target_ck`: exatamente um entre get_id, purchase_id e order_id. **getcoin_ledger.type** ganhou `MARKET_ESCROW`, `MARKET_ESCROW_RETURN` e `MARKET_BUY`.
- _(D11)_ **getcoin_purchases.package_id** agora é opcional (null = compra avulsa, `package_name = "Avulso"`).
- Migração da rodada: `0008_market.sql` (nenhuma antiga editada).
- _(D4)_ **getcoin_ledger.type** ganhou `COUPON` (migração `0003_settings_coupons.sql`, que também cria as tabelas acima).

## 6. Regras de negócio

1. **Get**: `total = cash + getcoin`; `getcoin <= cash` (turbinar até o mesmo valor pago em dinheiro); `total >= min_get_cents` da Vibe; Vibe precisa estar `LIVE` e dentro de `starts_at..ends_at`; usuário `ACTIVE`, e-mail verificado, CPF preenchido e maior de 18.
2. GetCoin do Get é debitado na criação (dentro da transação, com lock na carteira); se o pagamento falhar/expirar, o GetCoin é devolvido (`REFUND`).
3. O Get só conta na disputa após `payments.status = PAID` (`gets.status = CONFIRMED`).
4. Header `Idempotency-Key` obrigatório em `POST /vibes/:id/gets`: repetir a mesma chave devolve o mesmo Get, não cria outro.
5. **Encerramento (settlement)**, idempotente e em transação: vence o maior `total_cents` confirmado (empate → o mais antigo). Perdedores recebem `floor(cash_cents * cashback_percent / 100)` em GetCoin (`CASHBACK`) por Get. Vencedor vira `VIBER`. Vibe vai para `ENDED` com `winner_get_id` e `settled_at`. Vibe sem Gets confirmados termina sem vencedor.
6. O maior Get público é exibido sem expor dados pessoais (só primeiro nome + inicial).

### 6.1 Decisões do cliente (2026-09-25) — prevalecem sobre as regras acima

- **D1 — Prazo final (resolve QA-09).** Nenhum Get novo é aceito no **último minuto** da Vibe: `POST /vibes/:id/gets` recusa com `409 VIBE_CLOSING` quando `now >= ends_at - get_cutoff_seconds` (padrão 60). Os Gets criados antes do corte têm **40 s de margem** (`payment_grace_seconds`) após o corte para o pagamento ser confirmado, ou seja, prazo de pagamento = `ends_at - get_cutoff_seconds + payment_grace_seconds` (padrão `ends_at - 20 s`). Quando o Get é criado perto do fim, o `expires_at` do pagamento é o menor valor entre o TTL normal e esse prazo. PAID que chega depois desse prazo **não conta** e é estornado (fluxo QA-01). Com isso o resultado é determinístico: não depende do momento em que o job roda. Os dois valores são configuráveis pelo admin (D3).
  _Interpretação do agente principal sobre a frase do cliente "Não pode aceitar mais nenhum Get no minuto final / 40 segundos de margem"; ainda falta o cliente confirmar._
- **D2 — Vencedor sem cashback (resolve QA-14).** Quem vence a Vibe **não recebe** os 40% em nenhum dos Gets dele naquela Vibe, nem no vencedor nem nos outros. Os perdedores continuam recebendo por Get.
- **D3 — Configurações pelo admin.** Os valores do bônus de boas-vindas, do bônus de indicação, `get_cutoff_seconds`, `payment_grace_seconds` e o cashback padrão das Vibes novas deixam de vir do env e passam a ser **definidos pelo ADMIN no dashboard**. Ficam numa tabela `settings` (chave/valor tipado, validado com Zod, com histórico no audit log). As variáveis de env viram só o valor inicial do seed.
- **D4 — Cupons.** O ADMIN cria cupons que creditam GetCoin:
  - campos: código (único, sem diferenciar maiúsculas), valor em centavos, limite total de resgates, limite por usuário (padrão 1), início e fim de validade, ativo/inativo, restrição opcional "só contas novas";
  - resgate em `POST /me/coupons/redeem` ou no cadastro (`couponCode`), creditando no livro-razão com o tipo `COUPON`;
  - o resgate é atômico: lock no cupom e contador, com `UNIQUE(coupon_id, user_id)` quando o limite por usuário é 1;
  - o resgate tem rate limit, e um código inválido, expirado ou esgotado recebe sempre a mesma resposta genérica.
- **D5 — Produtos e leilões vêm do dashboard.** Os 8 produtos do seed são **fictícios**, só para demonstração. O ADMIN cadastra produto e leilão pelo dashboard, inclusive com **upload de imagem**. O seed de demonstração só roda com `--demo` e nunca em produção. Em produção, o seed cria apenas o admin e as configurações iniciais.

### 6.2 Dashboard do cliente, fase 1 (decisões do cliente em 2026-09-25)

Pedido do cliente para o dashboard:
- **Início:** saldo em carteira, Meus Gets, GetCoins, nível, código de indicação e Comprar GetCoins.
- **Minha Conta:** dados do usuário, endereço com busca por CEP (o usuário só digita o número) e troca de senha.
- **Meus Gets:** números (participadas, ativas, vencidas), histórico de lances e destaque para os lances que o usuário está vencendo.
- **Carteira de GetCoins:** com extrato.
- **Marketplace de GetCoins entre usuários:** fica para a fase 2 (seção 6.3, a escrever).

- **D6 — Saldo em carteira (R$) sacável, separado do GetCoin.**
  - Tabelas: `cash_wallets` (saldo em centavos, com CHECK >= 0) e `cash_ledger`, imutável, com trigger igual ao do `getcoin_ledger`.
  - Tipos de lançamento: `GET_PAYMENT`, `GETCOIN_PURCHASE`, `WITHDRAWAL`, `WITHDRAWAL_REVERSAL`, `ADJUSTMENT`, e depois `MARKETPLACE_SALE` e `MARKETPLACE_FEE` (fase 2).
  - Mesmas garantias da carteira de GetCoin: uma função única de movimentação, transação com `FOR UPDATE` e invariante soma do livro-razão == saldo.
  - O saldo pode pagar Get e compra de GetCoin (método `BALANCE`, confirmado na hora, sem passar pelo provedor).
  - **Saque:** `POST /me/withdrawals { amountCents, pixKeyType, pixKey }`, com `Idempotency-Key`.
    - Exige e-mail verificado e CPF preenchido.
    - Valor mínimo e máximo diário vêm das configurações (`withdraw_min_cents`, `withdraw_daily_max_cents`).
    - O valor é debitado na hora (reserva), com status `PENDING`.
    - O ADMIN aprova (`PAID`) ou recusa (`REJECTED`, com estorno via `WITHDRAWAL_REVERSAL`). Tudo gera audit log.
    - Chave Pix é dado pessoal: guardar mascarada nas respostas e no log.
  - Estornos de Get pagos por Pix continuam voltando pelo provedor. Um Get pago com saldo é estornado para o saldo.
- **D7 — Comprar GetCoins por pacotes do admin.**
  - Tabela `getcoin_packages`: nome, getcoins em centavos, bônus em centavos, preço em centavos, ativo e ordem. CRUD em `/admin/getcoin-packages`, só ADMIN, auditado.
  - Compra: `POST /me/getcoin-purchases { packageId, method: PIX|CARD|BALANCE }`, com `Idempotency-Key`. Cria `getcoin_purchases` (status `PENDING_PAYMENT|PAID|FAILED|REFUNDED`) e um pagamento.
  - Generalizar `payments`: `get_id` passa a ser opcional e entra `purchase_id`, com um CHECK exigindo exatamente um dos dois.
  - Quando o pagamento é `PAID`, credita GetCoin: lançamento `PURCHASE` com o valor do pacote mais `PURCHASE_BONUS` se houver bônus. É idempotente e segue o fluxo de PAID tardio do QA-01.
  - A regra "GetCoin ≤ valor pago em dinheiro" por Get continua valendo.
  - `GET /getcoin-packages` é público e lista só os pacotes ativos.
- **D8 — Endereço com CEP.**
  - Novos campos em `users`: `cep`, `street`, `number`, `complement`, `district`, `city`, `state` (UF). Todos opcionais até a entrega de um prêmio.
  - `PUT /me/address`: CEP com 8 dígitos, UF validada e número obrigatório.
  - `GET /cep/:cep` é um proxy com cache em memória (24 h) e rate limit. Consulta o ViaCEP e cai para a BrasilAPI se falhar. Responde `{ cep, street, district, city, state }` e 404 para CEP inexistente.
  - O front preenche rua, bairro, cidade e UF, e o usuário digita o número e o complemento.
- **D9 — Meus Gets.**
  - `GET /me/gets/summary` → `{ participated, active, won, lost, leading }`.
    - `participated` = Vibes distintas com pelo menos 1 Get confirmado.
    - `active` = Vibes LIVE em que o usuário tem Get confirmado.
    - `won` = Champion Gets.
    - `lost` = Vibes encerradas sem vitória.
    - `leading` = Vibes LIVE em que o maior Get confirmado atual é do usuário.
  - `GET /me/gets` ganha, por item, `isLeading` e `vibeStatus`.
  - `GET /me/gets/leading` lista as Vibes em que o usuário está vencendo, com produto, o maior Get dele, o prazo (`getsCloseAt`) e o número de participantes. Nunca expõe dados de outros usuários.
  - Na tela, o card "Vencidas" mostra as **vitórias (Champion Gets)**. Interpretação do agente principal: "vencida" no sentido de ganha; falta o cliente confirmar.
- `GET /me/dashboard` passa a incluir `cashBalanceCents`, `getsSummary` e `referralCode`.

### 6.3 Compra avulsa de GetCoins e marketplace (decisões do cliente em 2026-09-28)

Unidades: GetCoin sempre em **centavos de GetCoin** (100 = 1 GetCoin); preços em **centavos de R$**. Quantidades avulsas e de marketplace são **GetCoins inteiros** (múltiplos de 100).

- **D11 — Compra avulsa (além dos pacotes do D7).**
  - Novas configurações do ADMIN, no mesmo padrão de `/admin/settings/withdrawals`, em `GET|PATCH /admin/settings/getcoin`:
    - `getcoinUnitPriceCents`: preço de 1 GetCoin em R$ (padrão 100);
    - `getcoinCustomMinCents` e `getcoinCustomMaxCents`: faixa por compra (padrão 1.000 a 100.000);
    - `getcoinCustomEnabled` (padrão true).
  - `POST /me/getcoin-purchases` passa a aceitar **exatamente um** de `{ packageId }` ou `{ customGetcoinsCents }`, junto com `method` e o `Idempotency-Key`.
    - Preço avulso = `customGetcoinsCents / 100 × getcoinUnitPriceCents`, sem bônus.
    - A compra guarda o snapshot com `packageName: "Avulso"` e `package: null`. O `packageId` passa a ser opcional.
  - `GET /getcoin-packages` passa a devolver também `custom: { enabled, unitPriceCents, minCents, maxCents }`.
- **D12 — Marketplace de GetCoins entre usuários.**
  - **Anúncio:** o vendedor anuncia uma quantidade de GetCoins e o preço por GetCoin.
    - Limites vêm das configurações do ADMIN: `marketFeePercent` (padrão 10, de 0 a 50), `marketMinUnitPriceCents` e `marketMaxUnitPriceCents` (padrão 10 a 1.000), `marketMinListingCents` (padrão 1.000), `marketEnabled` (padrão true).
    - Rotas das configurações: `GET|PATCH /admin/settings/market`.
    - Ao anunciar, os GetCoins saem da carteira para custódia: lançamento `MARKET_ESCROW` negativo.
    - Cancelar o anúncio devolve o que resta, com `MARKET_ESCROW_RETURN`.
  - **Compra:** o comprador leva a quantidade que quiser, até o que resta no anúncio.
    - Na criação do pedido, a quantidade sai de `remaining` com lock (sem vender além do disponível).
    - O pedido gera um pagamento (PIX, CARD ou BALANCE), no mesmo fluxo e prazos dos pagamentos existentes.
  - **Pagamento confirmado (PAID)**, uma única vez e em transação:
    - o comprador recebe os GetCoins (`MARKET_BUY`);
    - o vendedor recebe o valor bruto no saldo em R$ (`MARKET_SALE`) e paga a taxa (`MARKET_FEE` negativo);
    - `fee = floor(total × marketFeePercent / 100)` e `sellerNet = total − fee`.
  - **Pagamento falho ou expirado:** a quantidade volta para o anúncio. Se o anúncio já foi cancelado ou esgotado, volta para a carteira do vendedor.
  - **PAID atrasado:** é estornado, no mesmo padrão do QA-01.
  - **Regras:**
    - ninguém compra do próprio anúncio;
    - vendedor e comprador precisam ter e-mail confirmado e conta ativa;
    - o público vê o vendedor só pelo nome público.
  - **Tabelas:**
    - `market_listings`: id, seller_id, unit_price_cents, total_cents, remaining_cents, status (`ACTIVE`, `SOLD_OUT` ou `CANCELLED`), timestamps;
    - `market_orders`: id, listing_id, buyer_id, seller_id, getcoins_cents, unit_price_cents, total_price_cents, fee_cents, seller_net_cents, status (`PENDING_PAYMENT`, `PAID`, `FAILED` ou `REFUNDED`), idempotency_key com unique por comprador.
    - `payments` ganha `order_id`, e o CHECK passa a exigir exatamente um entre get, purchase e order.
  - **Rotas:**
    - `GET /market/listings?sort=price|recent&page=` (público): `{ data: [{ id, seller: "Pedro A.", unitPriceCents, remainingCents, totalCents, createdAt }], meta }`, só anúncios ACTIVE com saldo restante maior que zero;
    - `POST /me/market/listings { getcoinsCents, unitPriceCents }` → `201 { data: listing }`;
    - `GET /me/market/listings` e `POST /me/market/listings/:id/cancel`;
    - `POST /market/listings/:id/orders { getcoinsCents, method }` com `Idempotency-Key` → `201 { data: order }`, onde order = `{ id, listingId, getcoinsCents, unitPriceCents, totalPriceCents, status, payment: { id, status, pixCopyPaste, expiresAt } }`. Com BALANCE, o pedido já volta PAID;
    - `GET /me/market/orders` (minhas compras), `GET /me/market/orders/:id` (acompanhar o Pix) e `GET /me/market/sales` (vendas nos meus anúncios, com `feeCents` e `sellerNetCents`);
    - admin: `GET /admin/market/listings`, `GET /admin/market/orders` e `POST /admin/market/listings/:id/cancel`, todos com audit.
  - `POST /payments/:id/simulate` e o webhook precisam funcionar também para pagamentos de pedido.
  - O painel admin mostra a receita de taxas (soma de `fee_cents` dos pedidos pagos).

## 7. Contrato da API (`/api/v1`)

Erros sempre em `{ "error": { "code": "STRING", "message": "texto pt-BR", "details"?: [...] } }`. Paginação: `?page=1&pageSize=20` (máx 100) → `{ data, meta: { page, pageSize, total } }`.

**Públicas**
- `GET /health`
- `GET /vibes?category=&status=&page=` · `GET /vibes/:slug`

**Auth**
- `POST /auth/register` — name, email, password (mín. 10, checa lista de senhas comuns), cpf?, phone?, birthDate?, acceptTerms: true, referralCode?
- `POST /auth/login` — resposta genérica em falha (não revela se o e-mail existe); bloqueio de 15 min após 5 falhas
- `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/logout-all`
- `GET /auth/me`
- `POST /auth/verify-email` · `POST /auth/resend-verification`
- `POST /auth/forgot-password` (sempre 202) · `POST /auth/reset-password` (revoga todas as sessões)
- `PATCH /auth/password` (exige senha atual)

**Usuário logado**
- `GET /me/dashboard` — nível, saldo, Gets ativos, vitórias, cashback recebido, últimas movimentações
- `PATCH /me` — só name, phone, cpf (se vazio), birthDate (se vazio), marketingOptIn
- `GET /me/gets` · `GET /me/wallet` (extrato paginado)
- `GET /me/export` (LGPD) · `DELETE /me` (exige senha; anonimiza)

**Gets e pagamentos**
- `POST /vibes/:id/gets` — `{ cashCents, getcoinCents, method }` + `Idempotency-Key` → Get pendente + dados do Pix mock
- `POST /payments/webhook` — assinatura HMAC-SHA256 no header `X-Signature` com `PAYMENT_WEBHOOK_SECRET`. Corpo (JSON, estrito): `{ externalId, status: "PAID"|"FAILED", paidAt? }`. _(QA-21)_ `paidAt` é o horário do pagamento no provedor (ISO 8601 com fuso) e faz parte do corpo assinado. O servidor usa `paidAt` limitado a `[chegada − 120 s, chegada]` (nunca no futuro); sem `paidAt`, usa a chegada. PAID com esse horário depois de `expires_at` ou de `ends_at` é estornado. Resposta `200 { received: true, changed }`
- `POST /payments/:id/simulate` — **só em `NODE_ENV !== 'production'`**, marca como pago/falho _(endurecido na correção do QA-05: só com `NODE_ENV=development|test` explícito)_

**Admin** (`SUPPORT` só leitura, `ADMIN` escrita)
- `GET /admin/dashboard` — usuários (total/novos 7d/por nível), Vibes por status, receita confirmada, GetCoin emitido vs gasto, Gets 24h
- `GET /admin/users` (busca, filtros) · `GET /admin/users/:id` · `PATCH /admin/users/:id` (role, status)
- `POST /admin/users/:id/wallet-adjustments` — `{ amountCents, reason }`
- `POST /admin/users/:id/cash-adjustments` — `{ amountCents, reason }`: ajuste manual do **saldo em R$** (D6). Tem as mesmas regras do ajuste de GetCoin (só ADMIN, motivo obrigatório, nunca a própria conta) e grava `cash_ledger ADJUSTMENT` com audit `CASH_ADJUSTED`. Adicionado na revisão de 2026-09-28.
- `GET|POST /admin/products` · `PATCH /admin/products/:id`
- `GET|POST /admin/vibes` · `PATCH /admin/vibes/:id` · `POST /admin/vibes/:id/close`
- `GET /admin/audit-logs`
- _(D3)_ `GET /admin/settings` · `PATCH /admin/settings` (só ADMIN; auditado) — **implementado**
- _(D4)_ `GET|POST /admin/coupons` · `PATCH /admin/coupons/:id` · `GET /admin/coupons/:id/redemptions`; usuário: `POST /me/coupons/redeem` `{ code }` — **implementado** (resgate: rate limit 10/15 min por IP; resposta `{ data: { amountCents, balanceCents } }`; `POST /auth/register` aceita `couponCode?` e responde `couponApplied`)
- _(D5)_ `POST /admin/uploads` (só ADMIN; multipart, imagem jpeg/png/webp validada por magic bytes, tamanho máximo, nome gerado pelo servidor, reprocessada ou sem metadados) → `{ url }` usado em `imageUrl` · `POST /admin/auctions` (cria produto + Vibe numa transação, para a tela "cadastro de leilão") — **implementado**: `POST /admin/uploads` → `201 { data: { url, contentType, bytes, width, height } }`; imagem servida em `GET /uploads/:name` (fora de `/api/v1`); `POST /admin/auctions { product, vibe }` → `201 { data: { product, vibe } }`. Também novo: `POST /vibes/:id/gets` pode responder `409 VIBE_CLOSING` (D1); `GET /vibes*` traz `getsCloseAt`; `cashbackPercent` em `POST /admin/vibes` virou opcional (padrão das configurações)

**Dashboard do cliente, fase 1 (D6–D9) — implementado em 2026-09-25.** Todas exigem login, salvo indicação. Valores em centavos; datas em ISO 8601. Exemplos são respostas reais (IDs encurtados).

_Usuário_
- `GET /me/cash?page=&pageSize=` (rota única escolhida, sem `/me/cash/ledger`) → `200 { "data": { "balanceCents": 5500 }, "ledger": { "data": [ { "id": "…", "amountCents": -4500, "balanceAfterCents": 5500, "type": "GETCOIN_PURCHASE", "referenceType": "purchase", "referenceId": "…", "reason": "Compra do pacote Pacote 50", "createdAt": "…" } ], "meta": { "page": 1, "pageSize": 20, "total": 2 } } }`. Ordem: `created_at desc, seq desc`.
- `POST /me/withdrawals` + `Idempotency-Key`, corpo `{ "amountCents": 2000, "pixKeyType": "CPF|EMAIL|PHONE|RANDOM", "pixKey": "529.982.247-25" }` → `201` (repetição: `200`) `{ "data": { "id": "…", "amountCents": 2000, "status": "PENDING", "pixKeyType": "CPF", "pixKeyMasked": "***.982.***-25", "createdAt": "…", "decidedAt": null, "rejectReason": null, "cashBalanceCents": 3500 } }`. Erros: `403 EMAIL_NOT_VERIFIED`, `422 CPF_REQUIRED`, `422 WITHDRAW_BELOW_MINIMUM`, `422 WITHDRAW_DAILY_LIMIT`, `422 INSUFFICIENT_BALANCE`, `400 VALIDATION_ERROR` (chave inválida), `409 IDEMPOTENCY_KEY_REUSED`. Rate limit 10/15 min.
- `GET /me/withdrawals?page=` → `{ "data": [ { "id", "amountCents", "status", "pixKeyType", "pixKeyMasked", "createdAt", "decidedAt", "rejectReason" } ], "meta" }`.
- `GET /getcoin-packages` (**público**) → `{ "data": [ { "id", "name": "Pacote 50", "getcoinsCents": 5000, "bonusCents": 500, "priceCents": 4500, "sortOrder": 1 } ] }` (só ativos, por `sortOrder` e preço).
- `POST /me/getcoin-purchases` + `Idempotency-Key`, corpo `{ "packageId": "…", "method": "PIX|CARD|BALANCE" }` → `201` (repetição: `200`):
  `{ "data": { "id": "…", "package": { "id": "…", "name": "Pacote 50", "getcoinsCents": 5000, "bonusCents": 500, "priceCents": 4500 }, "method": "PIX", "status": "PENDING_PAYMENT", "payment": { "id": "…", "status": "PENDING", "pixCopyPaste": "MOCKPIX|…", "expiresAt": "…", "paidAt": null }, "createdAt": "…", "balances": { "cashBalanceCents": 10000, "getcoinBalanceCents": 0 } } }`.
  Com `BALANCE`: `status: "PAID"`, `payment.status: "PAID"`, `pixCopyPaste: null` e `balances` já atualizados. Erros: `404 PACKAGE_NOT_FOUND` (inexistente ou inativo), `403 EMAIL_NOT_VERIFIED`, `422 INSUFFICIENT_BALANCE`, `409 IDEMPOTENCY_KEY_REUSED`. Rate limit 20/min.
- `GET /me/getcoin-purchases?page=` → `{ "data": [ <mesmo formato, sem balances> ], "meta" }`. `GET /me/getcoin-purchases/:id` → `{ "data": <mesmo formato, sem balances> }`; compra de outro usuário = `404`. O front pode consultar a cada poucos segundos até `status` virar `PAID`.
- `POST /payments/:id/simulate` (só development/test) funciona com o `payment.id` da compra; PAID credita `PURCHASE` + `PURCHASE_BONUS` uma única vez.
- `POST /vibes/:id/gets` aceita `method: "BALANCE"`: o Get nasce `CONFIRMED` e o pagamento vem `{ "provider": "INTERNAL", "method": "BALANCE", "status": "PAID", "pixCopyPaste": null }`; sem saldo → `422 INSUFFICIENT_BALANCE`.
- `PUT /me/address`, corpo `{ "cep": "01001-000", "street", "number" (obrigatório), "complement"?, "district", "city", "state": "SP" }` → `200 { "user": <toMe> }`. **`toMe`** (em `/auth/me`, `PATCH /me`, login, cadastro, dashboard) ganhou `"address": { "cep": "01001000", "street", "number", "complement", "district", "city", "state" } | null`. `PATCH /me` continua aceitando `phone`.
- `GET /cep/:cep` (**público**, 30/min) → `200 { "data": { "cep": "01001000", "street": "Praça da Sé", "district": "Sé", "city": "São Paulo", "state": "SP" } }`; `404 CEP_NOT_FOUND`; `400` formato; `503 CEP_UNAVAILABLE`.
- `GET /me/gets/summary` → `{ "data": { "participated": 1, "active": 1, "won": 0, "lost": 0, "leading": 1 } }`.
- `GET /me/gets/leading` → `{ "data": [ { "vibe": { "id", "slug", "endsAt", "minGetCents", "getsCloseAt" }, "product": { "name", "slug", "imageUrl" }, "myTopGet": { "id", "totalCents", "cashCents", "getcoinCents", "createdAt" }, "participants": 1 } ] }` (sem dados de outros usuários).
- `GET /me/gets`: cada item ganhou `"vibeStatus": "LIVE"` e `"isLeading": true|false` (além de `vibe`, `isChampion`, `payment`, `product`).
- `GET /me/dashboard`: `data` ganhou `"cashBalanceCents"`, `"getsSummary": { participated, active, won, lost, leading }` e `"referralCode"` (o `user` também traz `address`).
- `DELETE /me`: novo erro `409 CASH_BALANCE`.

_Admin_
- `GET /admin/getcoin-packages` (só ADMIN) → `{ "data": [ { "id", "name", "getcoinsCents", "bonusCents", "priceCents", "active", "sortOrder", "createdAt", "updatedAt" } ] }`; `POST` (corpo `{ name, getcoinsCents, bonusCents?, priceCents, active?, sortOrder? }`) → `201 { "data": <pacote> }`; `PATCH /admin/getcoin-packages/:id` (parcial) → `{ "data": <pacote> }`; `DELETE /admin/getcoin-packages/:id` → `204` ou `409 PACKAGE_IN_USE`. Auditado (`PACKAGE_CREATED/UPDATED/DELETED`).
- `GET /admin/withdrawals?status=PENDING|PAID|REJECTED&userId=&page=` (SUPPORT e ADMIN) → `{ "data": [ { <campos do usuário acima>, "userId", "userName", "userEmail", "decidedById", "pixKey": "52998224725" /* só para ADMIN */ } ], "meta" }`.
- `POST /admin/withdrawals/:id/approve` (só ADMIN, corpo vazio) → `{ "data": { <saque>, "status": "PAID", "userId", "cashBalanceCents" } }`. `POST /admin/withdrawals/:id/reject` `{ "reason": "Chave não confere" }` → `{ "data": { <saque>, "status": "REJECTED", "rejectReason", "userId", "cashBalanceCents" } }` com estorno `WITHDRAWAL_REVERSAL`. Erros: `409 WITHDRAWAL_ALREADY_DECIDED`, `403 SELF_DECISION_FORBIDDEN`, `404`. Auditado (`WITHDRAWAL_REQUESTED/APPROVED/REJECTED`, chave mascarada).
- `GET /admin/settings/withdrawals` / `PATCH /admin/settings/withdrawals` (só ADMIN) → `{ "data": { "withdrawMinCents": 1000, "withdrawDailyMaxCents": 500000 } }` (ver desvio na seção 3).

**D11/D12 — compra avulsa e marketplace (implementado em 2026-09-28).** GetCoin em centavos de GetCoin (100 = 1 GetCoin; quantidades em múltiplos de 100); preços em centavos de R$. Exemplos reais (IDs abreviados).

_Compra avulsa (D11)_
- `GET /getcoin-packages` (público) → `{ "data": [ <pacotes> ], "custom": { "enabled": true, "unitPriceCents": 100, "minCents": 1000, "maxCents": 100000 } }`.
- `POST /me/getcoin-purchases` aceita **exatamente um** de `packageId` ou `customGetcoinsCents` (+ `method`, `Idempotency-Key`). Avulsa → `201 { "data": { "id": "…", "package": { "id": null, "name": "Avulso", "getcoinsCents": 2500, "bonusCents": 0, "priceCents": 2500 }, "method": "PIX", "status": "PENDING_PAYMENT", "payment": { "id": "…", "status": "PENDING", "pixCopyPaste": "MOCKPIX|…|25.00|…", "expiresAt": "…", "paidAt": null }, "createdAt": "…", "balances": { "cashBalanceCents": 0, "getcoinBalanceCents": 0 } } }`. Erros novos: `400` (os dois ou nenhum; não múltiplo de 100), `422 CUSTOM_AMOUNT_OUT_OF_RANGE`, `422 CUSTOM_PURCHASE_DISABLED`.
- `GET|PATCH /admin/settings/getcoin` (só ADMIN) → `{ "data": { "getcoinUnitPriceCents": 100, "getcoinCustomMinCents": 1000, "getcoinCustomMaxCents": 100000, "getcoinCustomEnabled": true } }`.

_Marketplace (D12)_
- `GET /market/listings?sort=price|recent&page=&pageSize=` (público; só `ACTIVE` com `remaining > 0`) → `{ "data": [ { "id": "…", "seller": "Pedro A.", "unitPriceCents": 95, "remainingCents": 3000, "totalCents": 3000, "createdAt": "…" } ], "meta": { "page": 1, "pageSize": 5, "total": 1 }, "config": { "enabled": true, "feePercent": 10, "minUnitPriceCents": 10, "maxUnitPriceCents": 1000, "minListingCents": 1000 } }`.
- `POST /me/market/listings` `{ "getcoinsCents": 3000, "unitPriceCents": 95 }` → `201 { "data": { "id": "…", "unitPriceCents": 95, "totalCents": 3000, "remainingCents": 3000, "reservedCents": 0, "soldCents": 0, "status": "ACTIVE", "createdAt": "…" } }`. Erros: `422 MARKET_DISABLED`, `422 LISTING_BELOW_MINIMUM`, `422 UNIT_PRICE_OUT_OF_RANGE`, `422 INSUFFICIENT_GETCOIN`, `403 EMAIL_NOT_VERIFIED`.
- `GET /me/market/listings?page=` → `{ "data": [ { "id", "unitPriceCents", "totalCents", "remainingCents": 1900, "reservedCents": 1100, "soldCents": 0, "status", "createdAt" } ], "meta" }`.
- `POST /me/market/listings/:id/cancel` → `{ "data": { <anúncio>, "status": "CANCELLED", "remainingCents": 0, "returnedCents": 1900 } }`; de outro usuário `404`; já encerrado `409 LISTING_NOT_ACTIVE`.
- `POST /market/listings/:id/orders` `{ "getcoinsCents": 1100, "method": "PIX|CARD|BALANCE" }` + `Idempotency-Key` → `201` (repetição `200`) `{ "data": { "id": "…", "listingId": "…", "getcoinsCents": 1100, "unitPriceCents": 95, "totalPriceCents": 1045, "method": "PIX", "status": "PENDING_PAYMENT", "payment": { "id": "…", "status": "PENDING", "pixCopyPaste": "MOCKPIX|…|10.45|…", "expiresAt": "…", "paidAt": null }, "createdAt": "…", "balances": { "cashBalanceCents": 0, "getcoinBalanceCents": 0 } } }`. Com `BALANCE` já volta `status: "PAID"`. Erros: `403 OWN_LISTING`, `409 LISTING_INSUFFICIENT`, `409 LISTING_UNAVAILABLE`, `404`, `422 INSUFFICIENT_BALANCE`, `409 IDEMPOTENCY_KEY_REUSED`.
- `GET /me/market/orders?page=` e `GET /me/market/orders/:id` → mesmo formato do pedido (sem `balances`); pedido de outro usuário `404`. `POST /payments/:id/simulate` (dev) e o webhook aceitam o `payment.id` do pedido.
- `GET /me/market/sales?page=` → `{ "data": [ { "id", "listingId", "getcoinsCents": 1100, "unitPriceCents": 95, "totalPriceCents": 1045, "feeCents": 104, "sellerNetCents": 941, "status": "PAID", "createdAt" } ], "meta" }` (sem dados do comprador).
- `GET /admin/market/listings?status=&sellerId=&page=` (SUPPORT/ADMIN) → itens do anúncio + `"sellerId", "sellerName", "sellerEmail"`. `GET /admin/market/orders?status=&listingId=&userId=&page=` → `{ "data": [ { <pedido completo com buyerId, sellerId, feeCents, sellerNetCents>, "payment": { "id", "status", "method", "paidAt" } } ], "meta", "summary": { "feeRevenueCents": 104 } }`. `POST /admin/market/listings/:id/cancel` (só ADMIN) → igual ao cancelamento do dono.
- `GET|PATCH /admin/settings/market` (só ADMIN) → `{ "data": { "marketFeePercent": 10, "marketMinUnitPriceCents": 10, "marketMaxUnitPriceCents": 1000, "marketMinListingCents": 1000, "marketEnabled": true } }`.
- `GET /admin/dashboard` ganhou `"market": { "feeRevenueCents": 104, "paidOrders": 1 }`.
- `DELETE /me`: novo erro `409 MARKET_OPEN`.

## 8. Segurança (checklist obrigatório)

_[x] = implementado pelo builder (ainda precisa da confirmação do QA para ir a "feito", ver seção 2)._

**Revisão do QA (2026-09-25, atualizada na reverificação)** — `✅ QA` = confirmado por teste passando; `⚠️ QA` = funciona no caminho principal, mas há achado aberto (seção 9).

| Item | QA | Prova / achado |
| --- | --- | --- |
| Env validado | ✅ | `security.test.ts › validação de env`; `regression.test.ts › QA-05` (sem `NODE_ENV` = regras de produção, simulate 404) |
| Argon2id / tokens só como hash | ✅ | `auth.test.ts` (hash `$argon2id$`), `sessions.test.ts` (refresh só como SHA-256) |
| Refresh httpOnly/Secure/Strict, rotação, reuso | ✅ | `sessions.test.ts` (atributos, rotação, reuso revoga a família, outra família intacta). [QA-06] verificado (`409 REFRESH_RACE`); o front precisa de single-flight entre abas |
| CSRF | ✅ | `security.test.ts › CSRF` (sem header, Origin fora da allowlist, `null`, sufixo malicioso; produção exige Origin) |
| Helmet, CORS, rate limit | ✅ | `security.test.ts` (CSP/nosniff/HSTS em prod, CORS allowlist, 429 em login/register/forgot, por IP, XFF ignorado). [QA-03] verificado (`TRUST_PROXY` por saltos/lista) |
| Lockout + mensagens genéricas | ✅ | `auth.test.ts`, `regression.test.ts` (QA-07, 08, 10 e 16 verificados; no máximo 5 senhas por janela de bloqueio, também em paralelo) |
| D4 cupons: resposta genérica, rate limit, atomicidade | ✅ | `d4-coupons.test.ts` (mesmo status e corpo para 8 motivos de falha, tempo equivalente, 429 no 11º, 10 usuários paralelos num cupom de 3 → 3 resgates) |
| D5 upload seguro | ✅ | `d5-uploads-auctions.test.ts` (magic bytes, re-codificação, bomba de descompressão, path traversal, headers). Observação: [QA-20] armazenamento local |
| D12 marketplace: conservação, taxa, concorrência, IDOR | ✅ | `d11-d12-qa.test.ts` (Σ carteiras + custódia constante em todos os cenários; 8 compradores paralelos num anúncio de 50 GC → 5; cancelamento em paralelo com FAILED/PAID; replay sem crédito duplo; IDOR 404). Abertos: [QA-23] reserva sem custo, [QA-24] vendedor suspenso |
| Autorização por role / IDOR | ✅ | `rbac.test.ts` (matriz de 14 rotas × sem token/USER/SUPPORT/ADMIN, self-change, último ADMIN, IDOR em simulate e `/me/*`) |
| Zod `.strict()` + bodyLimit | ✅ | `auth/me/gets/admin.test.ts` (mass assignment), `security.test.ts` (413, 415, `__proto__`) |
| Erro nunca vaza stack/SQL | ✅ | `security.test.ts › erros não vazam detalhes` (banco derrubado → 500 genérico em dev e prod) |
| Logs com redact / audit | ✅ | redact de headers/campos; [QA-04] verificado com `DrizzleQueryError` real |
| Webhook HMAC / simulação fora de produção | ✅ | `payments.test.ts`, `regression.test.ts` ([QA-01] verificado: estorno idempotente em replay). Pendente para gateway real: consumidor (outbox) dos eventos `PROVIDER_*_REQUESTED` |
| Queries parametrizadas / `escapeLike` | ✅ | `admin.test.ts` (`%` e `_` literais na busca), `vibes.test.ts` (slug malicioso → 400) |
| LGPD | ✅ | `lgpd.test.ts`, `regression.test.ts` ([QA-15] verificado). Falta definir o prazo de retenção do audit log |
| CHECKs + trigger do livro-razão | ✅ | `settlement.test.ts`, `regression.test.ts` (UPDATE/DELETE/TRUNCATE/TRUNCATE CASCADE bloqueados) |

- [x] Env validado com Zod no boot; em produção recusa `JWT_SECRET` com menos de 32 caracteres e exige `DATABASE_URL` — `server/src/config/env.ts` (em produção também exige `PAYMENT_WEBHOOK_SECRET` com 32+ e `COOKIE_SECURE=true`)
- [x] Argon2id; comparação de tokens em tempo constante; tokens guardados só como hash — `src/lib/crypto.ts` (argon2id m=19MiB t=2; `safeEqual` com `timingSafeEqual`; refresh/verify/reset guardados como SHA-256; busca por hash indexado)
- [x] Refresh em cookie httpOnly/Secure/SameSite=Strict, rotação, reuso revoga a família — `src/modules/auth/service.ts` (`refresh`), cookie `vg_rt` em `src/modules/auth/routes.ts`
- [x] CSRF: rotas que usam cookie exigem header `X-Requested-With: fetch` e Origin na allowlist — `csrfGuard` em `src/plugins/security.ts` (Origin ausente só é aceita com `NODE_ENV=development|test`)
- [x] `@fastify/helmet`, CORS com allowlist (`CORS_ORIGINS`), `@fastify/rate-limit` global (300/min) + limites fortes: login 10/15min, register 10/h, forgot 5/15min, reset 10/15min, verify 20/15min — `src/plugins/security.ts` + `config.rateLimit` nas rotas
- [x] Lockout por conta (5 falhas → 15 min, incremento atômico em SQL) + rate limit por IP; mensagens genéricas; `fakePasswordVerify` iguala o tempo quando o e-mail não existe — `auth/service.ts#login`
- [x] Autorização por role em todas as rotas admin (hook `authenticate` + `requireRole('SUPPORT','ADMIN')`; escrita com `requireRole('ADMIN')`); `/me/*` sempre usa o id do token; simulação de pagamento checa o dono (404 para terceiros) — `src/modules/admin/routes.ts`, `src/plugins/auth.ts`
- [x] Zod `.strict()` em todos os corpos e queries; `bodyLimit` 64 KB — `src/modules/*/schemas.ts`, `src/app.ts`
- [x] Handler de erro que nunca vaza stack/SQL (em nenhum ambiente) — `src/plugins/errors.ts`
- [x] Logs com redact (`REDACT_PATHS` em `src/app.ts`); audit log: registro, login ok/falha/bloqueio, lockout, reuso de refresh, logout-all, verificação de e-mail, pedido/reset de senha, troca de senha, perfil, exclusão de conta, ações admin (usuário, carteira, produto, Vibe, encerramento) e pagamentos — `src/lib/audit.ts`
- [x] Webhook com HMAC-SHA256 sobre o corpo cru e comparação em tempo constante; rota de simulação só é registrada com `NODE_ENV=development|test` explícito (QA-05) — `src/modules/payments/routes.ts`; PAID tardio nunca é descartado (estorno + evento, QA-01); logs de erro de banco sem parâmetros (QA-04)
- [x] Queries só via Drizzle (parametrizadas); busca com `ILIKE` escapa curingas — `src/lib/pagination.ts#escapeLike`
- [x] LGPD: aceite de termos com versão (`terms_version`/`terms_accepted_at`), exportação (`GET /me/export`) e exclusão por anonimização (`DELETE /me`) — `src/modules/me/service.ts`
- [x] Extra: `CHECK` no banco para saldo >= 0, GetCoin <= cash, total = cash + GetCoin, CPF com 11 dígitos, e-mail minúsculo; trigger que torna o livro-razão imutável — `src/db/schema.ts`, `drizzle/0001_ledger_immutable.sql`

## 9. Estado atual

_Atualizar a cada sessão._

| Área | Status | Observações |
| --- | --- | --- |
| Especificação (este arquivo) | Feito | 2026-09-25 |
| Scaffold `server/` | Implementado, aguarda QA | Fastify 5, TS estrito ESM, `buildApp()` em `src/app.ts` com banco/mailer injetáveis |
| Schema + migrações + seed | Implementado, aguarda QA | `src/db/schema.ts`; `drizzle/0000_init.sql` + `0001_ledger_immutable.sql`; seed cria admin (via env), 8 produtos, 4 Vibes LIVE e 4 SCHEDULED |
| Auth | Implementado, aguarda QA | Todas as rotas de `/auth` da seção 7 |
| Usuário / dashboard | Implementado, aguarda QA | `/me/dashboard`, `PATCH /me`, `/me/gets`, `/me/wallet`, `/me/export`, `DELETE /me` |
| Carteira GetCoin | Implementado, aguarda QA | Função única `applyWalletMovement` (transação + `FOR UPDATE`) em `src/modules/wallet/service.ts` |
| Vibes / Gets / pagamentos mock | Implementado, aguarda QA | Get idempotente; webhook HMAC; simulação só fora de produção; expiração de pagamento via job |
| Settlement | Implementado, aguarda QA | `settleVibe` em `src/modules/vibes/settlement.ts` (idempotente, reutilizada pelo job e por `/admin/vibes/:id/close`) |
| Admin | Implementado, aguarda QA | Todas as rotas `/admin` da seção 7 + `GET /admin/gets` |
| Testes (QA) | Rodada D11–D12 validada | 512 testes em 26 arquivos: **509 passando, 3 falhando** ([QA-22], [QA-23], [QA-24], achados abertos com o comportamento esperado no teste). `npm run typecheck` limpo |
| D11 compra avulsa + D12 marketplace | Implementado, aguarda QA | 447 testes em 25 arquivos: **446 passando, 1 falhando (QA-22, já existente)**; inclui `tests/d11-d12-sanity.test.ts` (6 testes). Contrato na seção 7; decisões na seção 3 |
| Dashboard fase 1 (D6 saldo/saque, D7 pacotes/compra, D8 endereço/CEP, D9 Meus Gets) | QA concluído, com QA-22 aberto | D6, D7 e D9 verificados pela nova suíte; D8 funciona nos fluxos previstos, mas resposta 200 malformada do provedor de CEP não aciona fallback (QA-22) |
| Decisões D1–D5 (settings, cupons, upload, leilão, seed demo) | Verificado pelo QA, com achados BAIXO abertos | `d1-deadlines`, `d2-d3-settings`, `d4-coupons`, `d5-uploads-auctions` (69 testes). Abertos: QA-17 a QA-21 (todos BAIXO) |
| Integração com o front (proxy Vite, telas) | Dashboard do usuário em andamento | Proxy feito; telas `/dashboard`, `/dashboard/gets`, `/dashboard/carteira`, `/dashboard/comprar` e `/dashboard/conta` ligadas à API. Revisão responsiva concluída em 2026-09-25, incluindo Meus Gets, carteira e compra sem pacotes; ainda faltam cupom e ações LGPD no front (item 7.1) |

### Achados do QA

_Formato: `[ID] severidade — descrição — arquivo:linha — teste que prova — status (aberto/corrigido/verificado)`_

_Critério: CRÍTICO = explorável agora ou quebra dinheiro/autorização; ALTO = perda de dinheiro ou falha grave num fluxo previsto; MÉDIO = enfraquece um controle de segurança ou causa falha visível ao usuário; BAIXO = defesa em profundidade, higiene ou decisão pendente. Nenhum achado CRÍTICO._

- **[QA-01] ALTO** — Pagamento confirmado pelo gateway **depois** de o pagamento já estar `FAILED` é descartado em silêncio: `applyPaymentOutcome` devolve `changed:false` quando o status não é `PENDING`. Um pagamento vira `FAILED` quando expira (job, TTL 30 min) ou quando a Vibe encerra com o Get pendente (`failPendingGets`), mas o copia-e-cola do Pix continua pagável. Resultado: o cliente paga e fica sem Get e sem estorno. Isso acontece muito em Gets de último minuto, porque o encerramento falha os pendentes na hora e não espera o TTL. Hoje o provedor é MOCK, então nenhum dinheiro real se perde, mas **isso bloqueia a integração com gateway real**. Correção sugerida: PAID sobre `FAILED` → `REFUNDED` + estorno no provedor + audit, e/ou cancelar a cobrança no provedor ao expirar/encerrar. — `server/src/modules/payments/service.ts:75` (e `vibes/settlement.ts:28-43`, `payments/service.ts:123-131`) — `payments.test.ts › [QA-01] PAID que chega depois…` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: PAID sobre pagamento `FAILED` (expirado/falho/encerrado) e PAID com a Vibe encerrada/cancelada agora viram pagamento `REFUNDED` (com `paid_at`) + Get `REFUNDED` + GetCoin devolvido se ainda não foi (`refundGetcoinOfGet` idempotente, confere REFUND existente no livro-razão) + audit `PAYMENT_LATE_REFUND` + evento `PROVIDER_REFUND_REQUESTED` (chamada `mockProvider.refundCharge` depois do commit). Ao falhar cobranças pendentes (expiração, settlement, cancelamento) grava `PROVIDER_CHARGE_CANCEL_REQUESTED` e chama `cancelCharge`. Cancelamento de Vibe grava `PROVIDER_REFUND_REQUESTED` por pagamento estornado. `payments/service.ts#applyPaymentOutcome`, `refundLatePayment`, `failPendingPayment`; `vibes/settlement.ts#failPendingGets`
- **[QA-02] BAIXO** — Ordem de locks no settlement/cancelamento não é global: as carteiras dos pendentes são travadas em ordem de `user_id`, e depois as dos perdedores em outra sequência ordenada. Dois encerramentos/cancelamentos simultâneos de Vibes **diferentes** que compartilham usuários podem entrar em deadlock no Postgres. O Postgres aborta uma das transações: não há corrupção, mas o admin recebe 500 ou o job tenta de novo no próximo ciclo. Não dá para reproduzir no PGlite (uma conexão). Sugestão: coletar todos os `user_id` afetados e travar as carteiras uma vez, em ordem, no início. — `server/src/modules/vibes/settlement.ts:33,98` — sem teste (revisão) — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: `lockWalletsOfVibe` trava, logo após a Vibe, todas as carteiras dos usuários com Gets pendentes/confirmados, de uma vez e ordenadas por `user_id`, em `settleVibe` e `cancelVibe` — `vibes/settlement.ts`. Sem teste (PGlite não tem concorrência real)
- **[QA-03] BAIXO** — Rate limit por `req.ip` com `TRUST_PROXY=false` (padrão): atrás de proxy/load balancer, todos os usuários dividem o mesmo balde (login 10/15 min **para o site inteiro**). Com `TRUST_PROXY=true`, o IP vem do `X-Forwarded-For` e só é confiável se o proxy sobrescrever o header. Configuração de deploy, que precisa ser documentada no runbook. — `server/src/app.ts:61`, `server/src/plugins/security.ts:35` — `security.test.ts › X-Forwarded-For NÃO burla…` (comportamento atual) — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: `TRUST_PROXY` agora aceita `false` | `true` | número de saltos | lista de IPs/CIDRs (`config/env.ts`; número vira função de hops em `app.ts`). Documentado no `.env.example` e na seção 12. Padrão continua `false`
- **[QA-04] MÉDIO** — Erro de banco não tratado é logado com `req.log.error({ err })`. O `DrizzleQueryError` carrega `message`/`params` com os **valores** da query (e-mail, CPF, nome, telefone, hash argon2, hash de token) e o `redact` não alcança esses campos. Uma queda do Postgres durante cadastros joga PII no log (LGPD). Sugestão: serializer de `err` que remova `params`/`query` e reescreva a mensagem, ou logar só `err.code`/`err.cause.code`. — `server/src/plugins/errors.ts:51` — `security.test.ts › [QA-04] erro de query não deveria levar parâmetros (PII) para o log` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: Handler de erro, job e settlement logam só `safeErrorForLog(err)` (tipo, `code`, `constraint`, mensagem do driver sem literais/params) — `lib/log-safety.ts`. `REDACT_PATHS` agora cobre `err.message/stack/query/params/detail/where/internalQuery/cause`, com censor que sanitiza mensagem/stack (`logCensor`)
- **[QA-05] MÉDIO** — Configuração insegura por padrão: sem `NODE_ENV`, o app sobe como `development` com `JWT_SECRET`/`PAYMENT_WEBHOOK_SECRET` de dev **embutidos no código**, CSRF aceitando requisição sem Origin e a rota `POST /payments/:id/simulate` **registrada**, o que permite a qualquer usuário marcar o próprio Get como pago sem pagar. Basta um deploy sem `NODE_ENV=production`. O dano do segredo conhecido é limitado, porque o JWT precisa de um `sid` ativo e a role vem do banco. A simulação, porém, fica explorável direto. Sugestão: exigir `NODE_ENV` explícito, ou só usar os defaults de dev com `NODE_ENV=development|test`, e ligar a simulação por flag própria (`ENABLE_PAYMENT_SIMULATION=true`). — `server/src/config/env.ts:16,74-75`, `server/src/modules/payments/routes.ts:56` — `security.test.ts › [QA-05] sem NODE_ENV não deveria subir…` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: Sem `NODE_ENV` o app aplica regras de produção (`isProduction=true`): exige `DATABASE_URL` e `COOKIE_SECURE`, Origin obrigatória no CSRF, simulação desligada. Segredos fixos de dev só com `NODE_ENV=development|test`; sem NODE_ENV e sem segredo usa segredo aleatório efêmero (nunca o de dev) e o boot loga aviso. `NODE_ENV=production` explícito continua recusando segredo ausente/curto. `POST /payments/:id/simulate` só é registrada com `allowPaymentSimulation` (development|test explícito). `config/env.ts`, `payments/routes.ts`, `server.ts`
- **[QA-06] MÉDIO** — Corrida no refresh: duas renovações simultâneas com o mesmo cookie (duas abas, ou retry do front) fazem a segunda ser tratada como **reuso**, e a família inteira é revogada. O usuário é deslogado sem motivo. Sugestão: janela de tolerância curta (ex.: 10–30 s) em que o token recém-rotacionado devolve a sessão sucessora em vez de revogar. Alternativa: o front serializa o refresh (single-flight + BroadcastChannel entre abas), o que precisa entrar no contrato. — `server/src/modules/auth/service.ts:306-318` — `sessions.test.ts › [QA-06] duas renovações simultâneas…` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: Refresh distingue corrida de reuso pelo **momento de chegada**: se a requisição chegou antes da rotação (`receivedAt < revoked_at`) e dentro de `REFRESH_REUSE_GRACE_SECONDS` (15 s), responde `409 REFRESH_RACE`, **não** revoga a família e **não** apaga o cookie; o front repete com o cookie novo. Token apresentado depois da rotação continua revogando a família. `auth/service.ts#refresh`, hook `onRequest` em `app.ts`, `auth/routes.ts`. Nota: a janela só por tempo (sugerida) quebrava o teste `REUSO do refresh antigo…`, que reapresenta o token poucos milissegundos depois; por isso o critério é a chegada antes da rotação. Duas abas que renovam em sequência (sem sobreposição) ainda caem como reuso, então o front deve fazer single-flight (seção 11)
- **[QA-07] MÉDIO** — Lockout por conta com TOCTOU: `locked_until` é lido antes da verificação argon2 e o contador só é gravado depois. Requisições paralelas leem a conta desbloqueada e **todas** testam a senha: no teste, 20 tentativas paralelas avaliaram 20 senhas em vez de 5. O rate limit por IP limita isso a 10 por IP a cada 15 min, mas com vários IPs o limite de 5 por conta não vale. Sugestão: reservar a tentativa atomicamente antes do argon2 (`UPDATE users SET failed_login_count = … WHERE id = $1 AND (locked_until IS NULL OR locked_until < now()) RETURNING …`) e só então verificar. — `server/src/modules/auth/service.ts:236-259` — `auth.test.ts › [QA-07] 20 tentativas paralelas…` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: Reserva atômica da tentativa antes do argon2: `UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id=$1 AND (locked_until IS NULL OR locked_until <= now()) AND failed_login_count < 5 RETURNING` (`reservePasswordAttempt`). Sem linha = bloqueada (resposta genérica). Falha na 5ª tentativa reservada trava 15 min (`registerFailedAttempt`); sucesso zera (`clearPasswordAttempts`). `auth/service.ts`
- **[QA-08] BAIXO** — `forgot-password` tem tempo de resposta diferente conforme o e-mail existe: para conta existente grava token + audit e **aguarda** o envio do e-mail; para e-mail inexistente retorna na hora. Com mailer de 300 ms a diferença medida foi de aproximadamente 300 ms. É BAIXO porque o cadastro já revela a existência da conta com `409 ACCOUNT_EXISTS` (desvio aceito na seção 3). Sugestão: enviar o e-mail fora do ciclo da requisição (fila / `setImmediate`). — `server/src/modules/auth/service.ts:393-415` — `security.test.ts › [QA-08] resposta não deveria depender…` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: E-mail de reset enviado fora do ciclo da requisição (`sendInBackground`, erro só logado). O caminho de e-mail inexistente grava um audit `PASSWORD_RESET_REQUESTED` (`entity: auth`, `emailRef`, `known:false`) para igualar o trabalho de banco. `auth/service.ts#forgotPassword`
- **[QA-09] BAIXO** — Resultado não determinístico perto do prazo: um PAID que chega depois de `ends_at` conta na disputa se o job ainda não encerrou a Vibe (`vibeOpen = LIVE && !settledAt`, sem olhar `ends_at`). Se o job já rodou, o Get falha (ver QA-01). O mesmo Get pode ou não entrar na disputa conforme o momento do job (intervalo de 60 s). O cliente precisa decidir a regra: Gets criados antes do prazo têm até o TTL para pagar e o encerramento espera, ou nada depois de `ends_at`. — `server/src/modules/payments/service.ts:85` — sem teste (revisão) — status: **verificado pelo QA (rodada D1–D5), com a exceção do [QA-17]**. Estava: **resolvido por D1** (decisão do cliente, seção 6.1; builder 2026-09-25): corte de Gets no último minuto (`409 VIBE_CLOSING`), prazo do pagamento gravado em `expires_at` e PAID depois do prazo estornado. Teste de sanidade em `decisions-sanity.test.ts › D1` — aguardando reverificação
- **[QA-10] BAIXO** — Controles de tentativa: (a) qualquer pessoa bloqueia a conta de outra por 15 min errando a senha 5 vezes (trade-off clássico; considerar CAPTCHA/backoff em vez de bloqueio duro); (b) `PATCH /auth/password` (senha atual) e `DELETE /me` (senha) não contam falhas, só têm o rate limit por IP (10 e 5 a cada 15 min). Para explorar é preciso um access token roubado. — `server/src/modules/auth/service.ts:252-257,444`, `server/src/modules/me/service.ts:178` — sem teste dedicado (revisão) — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: (b) `PATCH /auth/password` e `DELETE /me` usam a mesma reserva atômica do login: senha errada conta, a 5ª trava por 15 min, conta travada responde `429 TOO_MANY_ATTEMPTS`; audit `PASSWORD_CHANGE_FAILED`/`ACCOUNT_DELETE_FAILED`/`ACCOUNT_LOCKED`. (a) Bloqueio duro mantido. Mitigação confirmada no código: o bloqueio só afeta fluxos que verificam senha (login, troca, exclusão); `forgot-password` não olha o bloqueio e `reset-password` zera `failed_login_count` e `locked_until`, então o titular sempre recupera o acesso pelo e-mail. CAPTCHA/backoff fica para depois (seção 11)
- **[QA-11] BAIXO** — Uma Vibe `LIVE` com prazo **já vencido** (antes de o job encerrar) pode ter o `endsAt` estendido e voltar a aceitar Gets, reabrindo uma disputa que o público já viu terminar. `POST /admin/vibes` também aceita criar `LIVE` com `endsAt` no passado. Só ADMIN faz isso. — `server/src/modules/admin/service.ts:357` (checa só o novo `endsAt`), `server/src/modules/admin/schemas.ts:85-92` — `admin.test.ts › [QA-11] não deve reabrir…` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: `PATCH /admin/vibes/:id` em Vibe LIVE com prazo vencido responde `409 VIBE_EXPIRED` (só cancelar é permitido); status resultante LIVE/SCHEDULED exige `endsAt` no futuro (400); `POST /admin/vibes` com LIVE/SCHEDULED e `endsAt` no passado responde 400. `admin/service.ts`
- **[QA-12] BAIXO** — A imutabilidade do livro-razão não cobre `TRUNCATE`, porque a trigger é `BEFORE UPDATE OR DELETE … FOR EACH ROW`. Sugestão: trigger `BEFORE TRUNCATE … FOR EACH STATEMENT` e, em produção, um usuário de app sem privilégio de `TRUNCATE`/`UPDATE` em `getcoin_ledger`. — `server/drizzle/0001_ledger_immutable.sql:8-10` — `settlement.test.ts › [QA-12] TRUNCATE…` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: Nova migração `drizzle/0002_ledger_no_truncate.sql`: trigger `BEFORE TRUNCATE … FOR EACH STATEMENT` com a mesma função. A recomendação de usuário de app sem UPDATE/DELETE/TRUNCATE no ledger está na seção 11
- **[QA-13] BAIXO** — `imageUrl` aceita `//evil.com/a.png` (protocol-relative), porque a regex de caminho relativo `^\/[A-Za-z0-9/_.-]+$` casa com `//`. Assim o front carrega imagem de host arbitrário (tracking), mas só ADMIN define esse campo. Sugestão: `^\/(?!\/)…`. — `server/src/modules/admin/schemas.ts:43` — `admin.test.ts › rejeita [QA-13] imageUrl protocol-relative` — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: Caminho relativo agora é `^\/(?!\/)…`, sem `..`; `https://` exige host em `IMAGE_HOSTS` (env, lista). Com `IMAGE_HOSTS` vazio, development/test aceitam qualquer host https (o teste `cria, lista…` usa `cdn.exemplo.com`) e produção não aceita nenhum (só caminhos relativos). `.env.example` traz `IMAGE_HOSTS=api.vibeget.net`. `admin/schemas.ts`, `admin/service.ts#assertImageHost`
- **[QA-14] BAIXO (decisão)** — Cashback do próprio vencedor: os outros Gets do usuário vencedor na mesma Vibe recebem cashback como "perdedores". A regra 6.5 não trata esse caso. O teste documenta o comportamento atual (passa); o cliente precisa confirmar. — `server/src/modules/vibes/settlement.ts:98` — `settlement.test.ts › [QA-14] documenta…` — status: **verificado pelo QA (rodada D1–D5)**: `d2-d3-settings.test.ts` (vencedor com 3 Gets recebe 0, empate) e `settlement.test.ts › [QA-14]`, cuja asserção não foi enfraquecida (vencedor 0, perdedor 800). Estava: **resolvido por D2** (decisão do cliente, seção 6.1; builder 2026-09-25): vencedor não recebe cashback em nenhum Get dele (`vibes/settlement.ts`, filtro por `user_id` do vencedor). O teste `settlement.test.ts › [QA-14]` foi **ajustado pelo builder** para a nova regra (vencedor 0, perdedor 800), conforme autorizado pelo coordenador; nenhum outro teste do QA foi alterado — aguardando reverificação
- **[QA-15] BAIXO** — LGPD: (a) `DELETE /me` limpa IP/UA das sessões, mas mantém `audit_logs.ip` do titular sem prazo de retenção definido; (b) `GET /me/export` traz só a atividade em que o titular é o **ator**, e ações de terceiros sobre ele (ajuste de carteira, suspensão) ficam de fora. Definir retenção e decidir se o export inclui `entity_id = titular`. — `server/src/modules/me/service.ts:147-150,206-229` — sem teste dedicado (revisão) — status: **verificado** (QA 2026-09-25, ver "Reverificação" abaixo). Correção do builder: (a) `DELETE /me` agora anula `audit_logs.ip` de todos os registros em que o titular é ator ou alvo (`entity=user, entity_id=titular`), e o próprio `ACCOUNT_DELETED` é gravado sem IP. O prazo de retenção do audit log continua a definir (seção 11). (b) `GET /me/export` inclui `actionsByOthers`: ação, data e metadata dos registros com `entity=user, entity_id=titular` feitos por terceiros/sistema, sem IP nem identidade de quem agiu. `me/service.ts`

- **[QA-16] BAIXO** — Efeito colateral da correção do QA-07: a tentativa de senha é reservada (contador +1) **antes** do argon2 e só é fechada depois (`registerFailedAttempt` na 5ª falha, `clearPasswordAttempts` no acerto). Se o processo cair, ou a query de registro falhar, entre as duas etapas justamente na 5ª tentativa, a conta fica com `failed_login_count = 5` e `locked_until = NULL`. Como `reservePasswordAttempt` exige `failed_login_count < 5`, login, troca de senha e exclusão ficam bloqueados **para sempre**; só o reset por e-mail destrava. Isso depende de uma falha numa janela de milissegundos, por isso é BAIXO. Sugestão: na reserva, aceitar também `failed_login_count >= 5 AND locked_until IS NULL AND updated_at < now() - 15 min`, ou gravar `locked_until` já na reserva da 5ª tentativa e limpar no acerto. — `server/src/modules/auth/service.ts:227-241` — `regression.test.ts › [QA-16] contador parado em 5…` — status: **verificado** (QA, rodada D1–D5: `regression.test.ts › QA-16 — reverificação`. Com 12 tentativas paralelas, 5 senhas são avaliadas por janela; depois que o bloqueio expira, mais 5, também em paralelo, e nunca ilimitadas. A 5ª reserva já grava `locked_until`, então uma interrupção bloqueia só 15 min e o acerto zera). Correção do builder (builder 2026-09-25): a reserva (`reservePasswordAttempt`) grava `locked_until = now() + 15 min` no MESMO `UPDATE` atômico que reserva a 5ª tentativa, então uma interrupção entre a reserva e o registro deixa a conta bloqueada no máximo 15 min. Além disso, o estado "contador >= 5 fora de bloqueio" (bloqueio expirado ou legado) é tratado como expirado e o contador recomeça em 1. O acerto de senha continua zerando contador e bloqueio. `auth/service.ts#reservePasswordAttempt`
- **[QA-17] BAIXO** — D1: o prazo de pagamento é fixado em `payments.expires_at` na criação do Get. Se o ADMIN **encurta** o `endsAt` de uma Vibe LIVE, os pagamentos já criados mantêm o `expires_at` antigo (até 30 min). Depois do novo fim, enquanto o job não encerra a Vibe (até 60 s), um PAID ainda confirma o Get. O resultado volta a depender do momento do job, que é justamente o que D1/QA-09 resolveram. Só acontece se o ADMIN encurtar uma Vibe em andamento. Sugestão: em `applyPaymentOutcome`, recusar também quando `now > vibeDeadlines(vibe.endsAt, cfg).paymentDeadline`, ou reduzir `expires_at` dos pendentes no PATCH que encurta `endsAt`. — `server/src/modules/payments/service.ts:161` (+ `admin/service.ts#patchVibe`) — `d1-deadlines.test.ts › [QA-17] encurtar endsAt…` — status: **corrigido — aguardando reverificação** (builder 2026-09-25): `patchVibe` lê as configurações antes da transação e, ao **encurtar** o `endsAt` de uma Vibe LIVE, faz na mesma transação `UPDATE payments SET expires_at = LEAST(expires_at, novo prazo)` para os pagamentos PENDING da Vibe (novo prazo = `vibeDeadlines(novo endsAt)`). Defesa extra em `applyPaymentOutcome`: PAID com horário `>= vibe.ends_at` também é estornado, então nada conta depois do fim, mesmo que o `endsAt` mude depois. `admin/service.ts`, `payments/service.ts`
- **[QA-18] BAIXO** — Ordem do extrato: vários lançamentos do mesmo usuário numa só transação (ex.: dois ou mais cashbacks no settlement, ou estorno + cashback) recebem o **mesmo** `created_at`, porque `defaultNow()` usa `now()` = início da transação, e os ids são UUIDv4 aleatórios. `/me/wallet` e `/me/dashboard` ordenam por `(created_at DESC, id DESC)`, então a ordem entre esses lançamentos é aleatória e o `balanceAfterCents` do topo pode não bater com o saldo. No teste, com 3 cashbacks, o topo ficou errado em 4 de 6 execuções. Saldo e soma **estão corretos**; o erro é só de apresentação e auditoria da sequência. Sugestão: coluna `seq bigserial` (ou `clock_timestamp()`, ou UUIDv7) para ordenar. — `server/src/db/schema.ts` (`createdAt`/`id` do `getcoin_ledger`), `server/src/modules/wallet/service.ts#listLedger` — `d2-d3-settings.test.ts › [QA-18] extrato…` — status: **corrigido — aguardando reverificação** (builder 2026-09-25): Nova coluna `getcoin_ledger.seq` (`bigint GENERATED ALWAYS AS IDENTITY`, migração `drizzle/0004_ledger_seq.sql`). O extrato (`listLedger`) e as últimas movimentações do dashboard ordenam por `(created_at desc, seq desc)`. `d2-d3-settings.test.ts` rodado 5x seguidas: 19/19 nas 5
- **[QA-19] BAIXO** — Configurações (D3) com várias instâncias: o cache em memória de 30 s só é invalidado na instância que recebeu o PATCH. Por até 30 s, instâncias diferentes aplicam corte/margem diferentes a Gets da mesma Vibe (o `expires_at` gravado continua coerente com o valor lido). Além disso, se qualquer linha de `settings` no banco ficar inválida (ex.: edição manual), `readAll` volta **todas** as chaves para os padrões do env em silêncio, sem log. Sugestão: logar/alertar o fallback, cair para o padrão só da chave inválida e, com várias instâncias, usar LISTEN/NOTIFY ou TTL menor. — `server/src/lib/settings.ts:57-64,73-78` — revisão, sem teste — status: **corrigido — aguardando reverificação** (builder 2026-09-25): Cache reduzido para **5 s** (`SettingsStore.CACHE_TTL_MS`). **Em multi-instância, uma mudança feita numa instância chega às outras em até 5 s.** Linha inválida no banco não cai mais em silêncio no env: loga erro (`configurações inválidas no banco`) e usa o **último valor válido** que a instância já leu; sem valor válido anterior, falha alto com `500 SETTINGS_INVALID`. O PATCH do ADMIN continua sendo o caminho de correção: parte do último valor válido e regrava todas as chaves. `lib/settings.ts`
- **[QA-20] BAIXO** — Upload (D5) grava em disco local (`UPLOAD_DIR`). Com várias instâncias ou em container com disco efêmero, a imagem só existe na instância que recebeu o upload (404 nas outras e perda no redeploy). Imagens enviadas e nunca usadas em produto também não são limpas. Para produção: storage de objetos (S3/R2) ou volume compartilhado, mais limpeza de órfãos. Resto do upload verificado: SVG, HTML renomeado, magic bytes falsos, poliglota (re-codificado sem o payload), EXIF removido, bomba de 100000×100000 recusada, 413 acima do limite, path traversal em `GET /uploads` → 404, headers `nosniff` + `CSP sandbox`, RBAC. — `server/src/modules/uploads/service.ts:47-50` — revisão, sem teste — status: **aberto — pendência de produção** (não codado nesta rodada, por decisão do coordenador; ver seção 11, item 3.2.3)
- **[QA-21] BAIXO** — D1 com gateway real: o PAID é comparado com `expires_at` usando a hora em que o **webhook chega** (`new Date()`), não a hora do pagamento informada pelo provedor. Webhooks atrasados ou reenviados (comum em Pix) fazem um pagamento feito dentro do prazo ser estornado. Com o MOCK isso não aparece. Na integração: usar o `paid_at` do provedor, validado e com tolerância pequena. — `server/src/modules/payments/service.ts:161` — revisão, sem teste — status: **corrigido — aguardando reverificação** (builder 2026-09-25): O webhook aceita `paidAt` opcional (ISO 8601 com fuso) **dentro do corpo assinado**. Horário efetivo = `paidAt` limitado a `[chegada − 120 s, chegada]`: nunca no futuro e no máximo 120 s de tolerância de relógio/atraso (`effectivePaidAt`, `WEBHOOK_CLOCK_SKEW_MS`). Sem `paidAt`, vale a chegada. Esse horário é comparado com `expires_at` e `ends_at` e gravado em `payments.paid_at`. `payments/{routes,service}.ts`
- **[QA-22] BAIXO** — D8 aceita como sucesso qualquer resposta HTTP 200 do ViaCEP, sem validar os campos obrigatórios. Uma resposta malformada (por mudança/instabilidade do provedor) vira `{ street: "", district: "", city: "", state: "" }`, **não aciona a BrasilAPI** e ainda fica no cache positivo por 24 h. O `PUT /me/address` continua validando os dados, então não há corrupção direta do perfil; o impacto é falha visível no autopreenchimento e indisponibilidade prolongada daquele CEP. Correção sugerida: validar a resposta normalizada de cada provedor (CEP, cidade e UF válida; campos textuais com tipo correto), tratar formato inválido como `undefined` e tentar o próximo provedor. — `server/src/modules/address/service.ts:65-81` — `d6-d9-qa.test.ts › [QA-22] trata resposta 200 malformada como falha e usa o provedor de backup` — status: **aberto**
- **[QA-23] MÉDIO** — D12: reserva de anúncio sem custo. Qualquer usuário verificado cria pedidos PIX/CARD que nunca paga, e cada pedido tira a quantidade do `remaining` por `PAYMENT_TTL_MINUTES` (30 min). Não há teto de pedidos pendentes por comprador nem por anúncio, e o rate limit é de 30 pedidos/min por IP. Uma única conta sem dinheiro trava 100% de vários anúncios e renova a trava quando os pedidos expiram: indisponibilidade do marketplace. No teste, 4 anúncios inteiros ficaram presos por um comprador sem saldo. Não há perda de GetCoin (a conservação se mantém). Sugestão: teto de pedidos pendentes por comprador (ex.: 1–3) e/ou por anúncio, TTL menor para pedidos de marketplace e bloqueio temporário de quem acumula pedidos expirados. — `server/src/modules/market/service.ts#createOrder` (~l. 310-330) — `d11-d12-qa.test.ts › [QA-23] um comprador sem dinheiro…` — status: aberto
- **[QA-24] BAIXO** — D12: vendedor suspenso. Suspender a conta (`PATCH /admin/users/:id`) não mexe nos anúncios: eles continuam `ACTIVE` e aparecem em `GET /market/listings`, mas todo pedido responde `409 LISTING_UNAVAILABLE`, o que deixa na vitrine uma oferta impossível de comprar. Os GetCoins ficam em custódia até um ADMIN cancelar manualmente. Sugestão: filtrar `users.status = ACTIVE` na lista pública e/ou cancelar (devolver) os anúncios na suspensão. — `server/src/modules/market/service.ts#listPublicListings` — `d11-d12-qa.test.ts › [QA-24] anúncio de vendedor suspenso…` — status: aberto

**Reverificação do QA (2026-09-25).** Li o código de cada correção, não só o teste. Os testes originais não foram alterados pelo builder. Acrescentei `tests/regression.test.ts` com 27 testes de regressão.

| ID | Resultado | O que conferi além do teste original |
| --- | --- | --- |
| QA-01 | verificado | PAID sobre `FAILED` vira `REFUNDED`. Replay de PAID (3×) muda o estado só na 1ª vez, com 1 `REFUND` no livro-razão, 1 `PAYMENT_LATE_REFUND` e 1 `PROVIDER_REFUND_REQUESTED`. `refundGetcoinOfGet` é idempotente por Get (procura `REFUND` existente). Cobre expirado, recusado e encerrado. O Get estornado nunca vence nem ganha cashback. Cancelamento seguido de PAID repetido não estorna de novo. Invariante do livro-razão ok. Resíduo conhecido: os eventos `PROVIDER_*_REQUESTED` ainda não têm consumidor (outbox), o que é pré-requisito do gateway real (seção 11) |
| QA-02 | verificado (leitura) | `lockWalletsOfVibe` trava todas as carteiras afetadas, em ordem, logo após a Vibe (`FOR UPDATE`). Com a Vibe travada não entram Gets nem pagamentos novos, então a lista é estável. Os outros fluxos travam no máximo 1 carteira, então não há ciclo. Sem teste: PGlite não tem concorrência |
| QA-03 | verificado (leitura) | `TRUST_PROXY` aceita false/true/saltos/lista; o teste de XFF com `false` continua passando |
| QA-04 | verificado | O handler de erro, o job e o settlement logam só `safeErrorForLog`, que para erro de banco usa a mensagem do driver sanitizada, sem `params`/`stack`/`detail`. Testado com um `DrizzleQueryError` real de INSERT com nome, e-mail, hash e CPF: nada vaza e o SQLSTATE fica. `REDACT_PATHS` + `logCensor` cobrem `err.*` se alguém logar `{ err }` no futuro |
| QA-05 | verificado | Sem `NODE_ENV`: `isProduction=true`, exige `DATABASE_URL` e `COOKIE_SECURE`, segredos aleatórios por boot (nunca os de dev), CSRF exige Origin, HSTS ligado e `simulate` → **404**, com o pagamento continuando `PENDING`. `NODE_ENV=development` explícito mantém a simulação |
| QA-06 | verificado, com ressalvas | Perdedor da corrida recebe `409 REFRESH_RACE`, sem token e sem apagar o cookie; o retry com o cookie novo funciona e só 1 de 3 chamadas simultâneas recebe tokens. **Exploração com token roubado:** a regra só vale para requisição que *chegou antes* da rotação e nunca entrega token. Reapresentar depois da rotação (o que o atacante sempre faz no 2º uso) continua revogando a família; o teste confirma. O pior caso é a detecção atrasar em 1 requisição. Ressalvas: (a) duas abas em *sequência* ainda deslogam, então o front precisa de single-flight entre abas (seção 11); (b) com várias instâncias, `receivedAt` e `revoked_at` vêm de relógios diferentes. Um desvio de relógio só troca 401 por 409 dentro da janela de 15 s, sem emitir token. Aceitável |
| QA-07 | verificado | Reserva atômica antes do argon2: 20 tentativas paralelas avaliam ≤ 5 senhas. Login correto em paralelo com 4 erradas entra, e o acerto zera o contador. Efeito colateral: ver **QA-16** |
| QA-08 | verificado | E-mail enviado em background; falha do provedor não afeta o 202 nem gera rejeição não tratada. O caminho de e-mail inexistente grava audit sem o e-mail em claro |
| QA-10 | verificado | A troca de senha conta falhas: a 5ª trava, depois `429 TOO_MANY_ATTEMPTS` mesmo com a senha certa, e o login também fica travado. O reset por e-mail destrava. `DELETE /me` com 5 erros → 429 e a conta **não** é excluída. Nota para o front: `429 TOO_MANY_ATTEMPTS` é um código novo no contrato |
| QA-11 | verificado | LIVE/SCHEDULED com `endsAt` no passado → 400 na criação. DRAFT vencida não vira LIVE. LIVE vencida só aceita cancelar (`409 VIBE_EXPIRED` no resto), e `/close` continua funcionando |
| QA-12 | verificado | Migração `0002`: `TRUNCATE` e `TRUNCATE … CASCADE` bloqueados |
| QA-13 | verificado | Em produção, com `IMAGE_HOSTS` vazio, só caminho relativo é aceito. Com allowlist: host em maiúsculas ok; recusados `evil.com`, `allowed@evil.com` (userinfo), `allowed.evil.com`, `/../`, `//host`. PATCH também é validado |
| QA-15 | verificado | O export traz `actionsByOthers` sem id nem IP do autor. Após `DELETE /me`, nenhum audit ligado ao titular guarda IP |
| QA-09, QA-14 | decisão do cliente | sem mudança de código (correto) |

**Decisões do cliente sobre QA-09 e QA-14:** resolvidas por D1 e D2 (seção 6.1). O texto abaixo descreve o comportamento **anterior**, mantido só como histórico:

- **QA-09 — pagamento perto do prazo.** Hoje: um Get criado antes de `ends_at` cujo PAID chega depois de `ends_at` **conta na disputa** se a Vibe ainda não foi encerrada (`status = LIVE` e sem `settled_at`). Se o encerramento (job a cada 60 s ou `/close`) já rodou, o Get pendente foi marcado como falho e o PAID tardio é **estornado** (QA-01). Opções para o cliente: (1) nada depois de `ends_at` conta; (2) Gets criados antes do prazo têm até o TTL do pagamento e o encerramento espera o TTL.
- **QA-14 — outros Gets do vencedor.** Hoje: no encerramento, só o Get vencedor fica sem cashback; os **demais Gets confirmados do mesmo usuário** na mesma Vibe recebem cashback como perdedores (`floor(cash × % / 100)`). O cliente precisa confirmar se o vencedor recebe cashback pelos outros Gets.

**Pontos que o builder deixou sem verificação — avaliação do QA:**

| Ponto | Avaliação |
| --- | --- |
| Postgres real (`DATABASE_URL`) | **Não testado** (sem Postgres na máquina). A leitura do código não mostra diferença de dialeto relevante: `bigint mode:number`, `sum()` tratado com `toNumber`, `count()` numérico, `isUniqueViolation` usa `code`/`constraint` do `pg`. Risco residual BAIXO, mas é **pré-requisito de produção** rodar a suíte contra Postgres. |
| Concorrência | O PGlite serializa as queries, então os testes de concorrência (`gets.test.ts` 10 Gets com o mesmo saldo; 5 com a mesma Idempotency-Key; `wallet.test.ts` 20 débitos; settlement em paralelo) provam a **lógica** (checagem dentro da transação, fallback de unicidade), não os locks. A leitura dos locks: carteira `FOR UPDATE` (correto contra gasto duplo), Vibe `FOR SHARE` em Get/pagamento × `FOR UPDATE` no settlement (correto), `patchUser` trava todos os ADMIN (correto). Risco: deadlock entre settlements ([QA-02]). |
| Corrida no refresh | Confirmada e reproduzida: [QA-06]. |
| Timing do forgot-password | Confirmado e medido: [QA-08]. O login usa `fakePasswordVerify` e é consistente. |

## 10. Log de sessões

- **2026-09-25** — Levantamento do projeto (front React/Vite sem backend), definição de stack e escrita desta especificação. Próximo: agente de criação faz o scaffold e a implementação.
- **2026-09-25 (builder)** — Criado `server/` com a implementação completa das seções 4–8 (todas as rotas da seção 7). Versões instaladas: fastify 5.12, drizzle-orm 0.45 + drizzle-kit 0.31, @electric-sql/pglite 0.5, zod 4, @fastify/jwt 10, typescript 7, vitest 5. Verificado localmente: `npm run typecheck` sem erros; `npm run db:generate` (0000_init + migração custom 0001); `db:migrate` e `db:seed` com PGlite (seed idempotente, rodado 2x); `npm test` 18/18; `npm run dev` + `GET /api/v1/health` = 200, login do admin do seed e `GET /admin/dashboard` = 200; `npm run build` compila. Proxy `/api` adicionado no `vite.config.js`. Desvios registrados na seção 3. Não testado: Postgres real via `DATABASE_URL` (sem Docker na máquina) e concorrência real (PGlite tem uma conexão só, então os `FOR UPDATE` não são exercitados de verdade nos testes).
- **2026-09-25 (QA)** — Li a spec e todo o `server/src`. Escrevi 12 arquivos de teste (`auth`, `sessions`, `rbac`, `me`, `wallet`, `vibes`, `gets`, `payments`, `settlement`, `admin`, `security`, `lgpd`) + `tests/qa-helpers.ts` (webhook assinado, JWT forjado, app em modo produção, invariante contábil `SUM(ledger) == wallets.balance` + `balance_after` do último lançamento + nenhum saldo negativo, checada ao fim de cada arquivo de dinheiro). Em `tests/helpers.ts`, `createTestApp` passou a aceitar `mailer` e a expor `closeDb()` (mudança compatível). Resultado real: `npm run typecheck` sem erros; `npm test` → **14 arquivos, 297 testes: 288 passando, 9 falhando** (QA-01, 04, 05, 06, 07, 08, 11, 12, 13), estável em duas execuções (~32 s). 15 achados registrados na seção 9: 0 crítico, 1 alto, 4 médios, 10 baixos (2 deles são decisões do cliente). Nenhum código de `server/src` foi alterado.
- **2026-09-25 (QA, reverificação)** — Li o código de cada correção (payments/service, vibes/settlement, auth/service, plugins/errors, lib/log-safety, config/env, admin/service+schemas, me/service, app.ts, migração 0002) e confirmei que os testes do QA não foram alterados. Criei `tests/regression.test.ts` com 27 testes: replay de PAID tardio, estorno único, TRUNCATE CASCADE, app sem NODE_ENV → simulate 404, troca de senha/exclusão contam falhas, allowlist de imagem em produção, LGPD pós-exclusão, corrida de refresh sem emissão de token. Resultado real: `npm run typecheck` sem erros; `npm test` → **15 arquivos, 324 testes: 323 passando, 1 falhando** ([QA-16], achado novo). Status: QA-01..08, 10..13 e 15 **verificados** (QA-02 e QA-03 por leitura), nenhum reaberto; QA-09/14 continuam como decisão do cliente.
- **2026-09-25 (builder, rodada de correção)** — Corrigidos QA-01, 02, 03, 04, 05, 06, 07, 08, 10, 11, 12, 13 e 15 em `server/src` (detalhe por achado na seção 9), mais a migração nova `drizzle/0002_ledger_no_truncate.sql`. QA-09 e QA-14 ficaram como decisão pendente do cliente, sem mudar o código. Nenhum teste do QA foi alterado. Arquivos: `config/env.ts`, `app.ts`, `server.ts`, `context.ts`, `lib/log-safety.ts` (novo), `plugins/auth.ts`, `plugins/errors.ts`, `jobs/index.ts`, `modules/auth/{service,routes}.ts`, `modules/me/service.ts`, `modules/payments/{service,routes}.ts`, `modules/vibes/settlement.ts`, `modules/admin/{schemas,service}.ts`, `.env.example`. Resultado real: `npm run typecheck` sem erros; `npm test` → **14 arquivos, 297/297 passando** (3 execuções completas + 8 execuções de `sessions`/`security`/`auth`, sem flakiness); `npm run db:migrate` aplicou a 0002 no PGlite de dev; boot + `GET /api/v1/health` = 200. Desvios de contrato novos: `409 REFRESH_RACE` em `/auth/refresh`; `429 TOO_MANY_ATTEMPTS` em `PATCH /auth/password` e `DELETE /me`; `409 VIBE_EXPIRED` em `PATCH /admin/vibes/:id`; campo `actionsByOthers` em `/me/export`; sem `NODE_ENV` = regras de produção.
- **2026-09-25 (builder, QA-16)** — `reservePasswordAttempt` passou a gravar `locked_until` já na reserva da 5ª tentativa e a tratar "contador >= 5 sem bloqueio vigente" como expirado (recomeça em 1). Só `server/src/modules/auth/service.ts` mudou; nenhum teste foi alterado. Resultado real: `npm run typecheck` sem erros; `npm test` → **15 arquivos, 324/324 passando**.
- **2026-09-25 (builder, decisões D1–D5)** — Implementado D1 (corte + prazo de pagamento em `expires_at` + estorno de PAID atrasado, `vibes/deadlines.ts`), D2 (vencedor sem cashback), D3 (`settings` + `GET/PATCH /admin/settings`, `lib/settings.ts`), D4 (cupons: `modules/coupons/*`, ledger `COUPON`, resgate atômico, cupom no cadastro), D5 (`modules/uploads/*` com multipart + sharp, `/uploads` servido, `POST /admin/auctions`, seed normal vs `--demo`). Migração nova `drizzle/0003_settings_coupons.sql` (nenhuma antiga editada). Testes: ajustado só `settlement.test.ts › [QA-14]` para D2; criado `tests/decisions-sanity.test.ts` (9 testes). Resultado real: `npm run typecheck` sem erros; `npm test` → **16 arquivos, 333/333 passando**; `npm run db:migrate` ok; `npm run db:seed` → "5 configurações iniciais gravadas / produtos de demonstração NÃO criados"; `npm run db:seed:demo` → "8 produtos"; boot + `/api/v1/health` = 200. Um travamento encontrado e corrigido no caminho: ler configurações dentro de transação (PGlite) deixava rotas admin em timeout.
- **2026-09-25 (QA, rodada D1–D5)** — Suíte das decisões: `tests/d1-deadlines.test.ts` (9), `tests/d2-d3-settings.test.ts` (19), `tests/d4-coupons.test.ts` (15), `tests/d5-uploads-auctions.test.ts` (26), mais 2 testes de reverificação do QA-16 em `regression.test.ts`. Em `qa-helpers.ts`, a checagem de encadeamento do livro-razão passou a tolerar lançamentos com o mesmo `created_at` (ver QA-18). Resultado real: `npm run typecheck` sem erros; `npm test` → **20 arquivos, 404 testes: 402 passando, 2 falhando** ([QA-17], [QA-18]). Reverificados: QA-09 (resolvido por D1, exceto QA-17), QA-14 (D2) e QA-16. Achados novos: QA-17 a QA-21, todos BAIXO. Nenhum código de `server/src` foi alterado.
- **2026-09-25 (builder, correções QA-17/18/19/21)** — QA-17: encurtar `endsAt` de Vibe LIVE recalcula `expires_at` dos pagamentos pendentes na mesma transação, e PAID depois de `ends_at` é sempre estornado. QA-18: coluna identity `getcoin_ledger.seq` (migração `0004_ledger_seq.sql`) e extrato ordenado por `(created_at, seq)`. QA-19: cache de configurações de 5 s; linha inválida → log de erro + último valor válido (ou `500 SETTINGS_INVALID`). QA-21: `paidAt` do provedor no webhook, limitado a 120 s de tolerância e nunca no futuro. QA-20 só registrado como pendência de produção. Nenhum teste do QA foi alterado. Resultado real: `npm run typecheck` sem erros; `npm run db:migrate` ok; `npm test` → **20 arquivos, 404/404 passando**; `d2-d3-settings.test.ts` 5x seguidas → 19/19 em todas.

- **2026-09-25 (front, telas de acesso)**
  - Feitas as telas `/login` e `/cadastro`, mais `/redefinir-senha`, `/verificar-email` e um `/dashboard` provisório, ligadas à API real. Detalhes na seção 13.
  - Estrutura escolhida pelo usuário: "Horizonte com painel de vidro". Contrato de design em `.impeccable/surfaces/src-pages-auth-jsx.md`.
  - A revisão final independente (impeccable-finish-reviewer) pediu 8 correções em 2 rodadas; 7 foram resolvidas e a da subida da moeda foi corrigida e conferida em captura (`.impeccable/review/rising-desktop.png`). Capturas em `.impeccable/review/`.
  - Testado no navegador: cadastro, erros de validação do servidor, conta duplicada, login com erro genérico, sessão mantida ao recarregar e sair.
- **2026-09-25 (builder, D6–D9)** — Implementados: D6 (`modules/cash`, `modules/withdrawals`: saldo R$ com `applyCashMovement` único, livro-razão imutável, Get e compra com `BALANCE`, saque com reserva/aprovação/recusa e estorno), D7 (`modules/purchases`: pacotes, compra PIX/CARD/BALANCE idempotente, `payments.purchase_id`, crédito `PURCHASE`/`PURCHASE_BONUS` só na transição para PAID, PAID tardio estornado), D8 (`modules/address`: `PUT /me/address`, proxy `/cep/:cep` com fallback e cache, `address` em `toMe`), D9 (`/me/gets/summary`, `/me/gets/leading`, `isLeading`/`vibeStatus`, dashboard ampliado). Rotas de leitura pedidas pelo front também feitas (`/me/cash`, `/me/withdrawals`, `/me/getcoin-purchases[/:id]`). Migrações novas `0005` e `0006`. Resultado real: `npm run typecheck` sem erros; `npm run db:migrate` ok; `npm test` → **21 arquivos, 413/413 passando**. Um conflito resolvido: as chaves de saque ficaram em `/admin/settings/withdrawals` porque o teste do QA fixa as 5 chaves de `/admin/settings` (seção 3).
- **2026-09-25 (QA, rodada D6–D9)** — Criado `tests/d6-d9-qa.test.ts` com 18 testes: invariante global e encadeamento do `cash_ledger`; bloqueio de UPDATE/DELETE/TRUNCATE CASCADE; corrida de saques contra o limite diário; replay concorrente de saque e compra; chave Pix ausente para USER/SUPPORT/export/audit/log; Get `BALANCE` com devolução única de R$ e GetCoin no cancelamento; `CASH_BALANCE` na exclusão; confirmação concorrente e PAID tardio de compra; snapshot do pacote; IDOR nas compras e no `simulate`; CHECK de alvo único do pagamento; CEP com ambos os provedores fora do ar/cache negativo/resposta malformada; desempate, participantes e contagem do D9. Resultado real: `npm run typecheck` sem erros; `npm test` → **22 arquivos, 431 testes: 430 passando, 1 falhando**. Achado novo: **QA-22 BAIXO** (ViaCEP 200 malformado não cai para BrasilAPI). Nenhum arquivo de `server/src` foi alterado.
- **2026-09-25 (front, layout do dashboard)** — Corrigida a densidade do dashboard do usuário em `src/pages/dashboard/Home.jsx` e `src/styles.css`: canvas útil ampliado de 1120 para 1240 px; Nível + Código de indicação consolidados num painel de apoio; carteira e painel lateral alinhados sem faixa vazia; contadores de Gets viraram uma faixa contínua; próximos passos usam duas colunas no desktop e uma no mobile; paddings e ritmo responsivo foram reduzidos. Capturas finais em `.impeccable/review/dashboard-after-{desktop,mobile}.png`: no estado de conta nova, altura total caiu de 1461 para 1147 px no desktop e de 2126 para 1906 px no mobile. `impeccable detect --scope layout` sem achados; `npm run build` concluído (permanece o aviso existente de bundle JS acima de 500 kB).
- **2026-09-25 (front, carteira e compra de GetCoins)** — Refinadas `src/pages/dashboard/Wallet.jsx`, `Buy.jsx`, `ui.jsx`, `src/components/form.jsx` e `src/styles.css`: painéis da carteira ganharam ritmo consistente; o saldo de GetCoins foi compactado e alinhado ao card da Home; a moeda agora usa o raio da marca; estados de erro/carregamento/vazio são exclusivos e orientam a próxima ação; a compra esconde pagamento e CTA quando não há pacotes; extratos vazios têm contexto; tabela e saques foram adaptados ao mobile; tabs receberam navegação por teclado e vínculo ARIA. Conferido autenticado em 1440×900 e 390×844 (`.impeccable/review/{wallet,buy}-layout-{desktop,mobile}.png`). `impeccable detect --scope layout` sem achados e `npm run build` concluído; permanece apenas o aviso existente de bundle JS acima de 500 kB.
- **2026-09-25 (front, Meus Gets)** — Refinados `src/pages/dashboard/Gets.jsx` e `src/styles.css`: os três indicadores deixaram de ser cards altos e viraram uma faixa única e compacta; para conta sem participação, os vazios de liderança e histórico foram consolidados em um único onboarding com CTA para explorar Vibes; estados de erro/carregamento/vazio ficaram exclusivos; o histórico passou a usar a linguagem “Gets” e preserva a data no mobile. Conferido autenticado em 1440×900 e 390×844, sem overflow horizontal; navegação Meus Gets → Carteira → Meus Gets validada. `impeccable detect --scope layout` sem achados e `npm run build` concluído; permanece apenas o aviso existente de bundle JS acima de 500 kB.

- **2026-09-28 (agente principal, revisão do dashboard)** — Revisão por leitura do front e do back do dashboard (fase 1).
  - **Back:**
    - (a) `POST /me/withdrawals` com chave `CPF` agora exige que seja o CPF do titular; senão responde `422 PIX_KEY_NOT_OWNER`, com o erro no campo `pixKey`. As outras chaves continuam sendo conferidas pelo ADMIN antes de pagar.
    - (b) Nova rota `POST /admin/users/:id/cash-adjustments`: até então não havia como creditar ou corrigir o saldo em R$ na fase 1.
  - **Front:**
    - selo "Champion Get" no histórico (`isChampion` já vinha da API);
    - a aba GetCoins da Carteira usa o `balanceCents` de `/me/wallet`, em vez de carregar `/me/dashboard`;
    - a dica da chave Pix muda conforme o tipo;
    - Comprar GetCoins avisa e bloqueia o envio quando o e-mail não está confirmado;
    - o saldo é recarregado depois que um Pix é confirmado.
  - Preservadas as melhorias feitas por outra pessoa nas telas: jornada de níveis, estados vazios, tabs acessíveis por teclado, `Submit` com `disabled` e moeda com raio.
  - **NÃO VERIFICADO:** o verificador de segurança do ambiente falhou em todas as tentativas de rodar Bash e PowerShell nesta sessão, então typecheck, testes e build **não foram rodados** depois dessas mudanças. Próxima sessão: rodar `npm run typecheck && npm test` em `server/` e `npx vite build` na raiz.
  - A rodada do QA para D6–D9 ficou incompleta: o agente parou no limite de gastos. Já existe `server/tests/d6-d9-qa.test.ts` parcial.
  - **Verificado depois, na mesma data:**
    - typecheck limpo;
    - `npx vitest run`: 22 arquivos, **430/431**. A única falha é o **QA-22** (o proxy de CEP não usa o provedor reserva quando recebe um 200 malformado), um teste do QA que prova um bug ainda aberto, não uma regressão;
    - `vite build` ok.
- **2026-09-28 (banco de dev corrompido)**
  - `server/.data/pglite` deixou de abrir: o PGlite aborta com `Aborted()`. A causa provável é o processo da API ter sido encerrado à força (`Stop-Process` / `TaskStop`) durante uma gravação.
  - O banco antigo foi preservado em `server/.data/pglite-corrompido-2026-09-28`, e foi criado um banco novo (`db:migrate` + `db:seed:demo`).
  - O usuário de teste `pedroagostini@trajetoriadosucesso.com` foi recriado com o e-mail já confirmado. A senha foi informada pelo usuário no chat e não está gravada em nenhum arquivo. Os outros usuários de teste, Gets e saldos antigos se perderam.
  - **Regra daqui em diante:** nunca matar a API com o PGlite aberto. Pare com Ctrl+C no terminal dela.
  - Ferramentas de dev novas, com a senha sempre por variável de ambiente e recusadas fora de `NODE_ENV=development|test`:
    - `NEW_PASSWORD=... npm run user:create -- email "Nome"`: cadastro real em processo, com o e-mail já confirmado.
    - `NEW_PASSWORD=... npm run user:set-password -- email`: troca a senha, revoga as sessões e zera o bloqueio.
  - O `vite.config.js` agora ignora `server/**` no watch. O observador do Vite prendia a pasta do banco no Windows e impedia renomeá-la.

- **2026-09-28 (página de Vibes)**
  - **Back:** `GET /vibes` ganhou:
    - `q`: busca no nome do produto, sem diferenciar maiúsculas, com curingas do LIKE escapados, de 1 a 80 caracteres;
    - `sort`: `ending` (padrão), `newest`, `min-get`, `price-high` e `price-low`;
    - `facets`: quantidade por categoria com os mesmos filtros de status e busca, ignorando a categoria escolhida.
  - Teste novo: `server/tests/vibes-browse.test.ts`.
  - **Front:** página `/vibes` (`src/pages/Vibes.jsx`), com `/leiloes` redirecionando para ela:
    - busca com espera de 300 ms;
    - abas Ao vivo, Em breve e Encerradas;
    - chips de categoria com contagem;
    - ordenação;
    - grade com "Carregar mais", esqueleto de carregamento e estados vazio e de erro;
    - filtros no endereço (`?q=&categoria=&status=&ordem=`), para o link filtrado poder ser compartilhado.
  - Cartão novo para dados da API: `src/components/VibeCard.jsx`. Trata ao vivo, em breve e encerrada, e produto sem foto.
  - O menu e o rodapé da home foram exportados de `App.jsx` (`Nav`, `Footer`, `useNow`, `countdown`, `spotlight`). Os links viraram `/#secao`, que na home apenas rola até a seção. "Vibes" leva para `/vibes`.
  - **NÃO VERIFICADO:** o verificador de segurança do ambiente bloqueou typecheck, teste e build. Rode `npm run typecheck && npx vitest run tests/vibes-browse.test.ts` em `server/` e `npx vite build` na raiz.
  - **Pendente:** a página de produto e Vibe (`/vibes/:slug`, com o botão de dar Get). Os cartões ainda levam para `vibeget.net/produto/...`.

- **2026-09-28 (página da Vibe — D10)**
  - **Decisões do cliente:**
    - benefícios = fixos da plataforma + extras cadastrados por Vibe no dashboard;
    - o Get funciona completo na página;
    - visitas contadas como visitante único por dia.
  - **Back:**
    - migração `0007_vibe_page.sql`: `products.brand`, `model`, `images` (galeria; a capa continua em `image_url`) e `specs` (ficha técnica, `[{label, value}]`); `vibes.benefits` e `vibes.views_count`; tabelas `vibe_views` e `favorites`;
    - `GET /vibes/:slug` passa a trazer `product.{brand, model, images, specs}`, `benefits`, `viewsCount`, `favoritesCount` e `recentGets` (últimos 10, só valor, horário e nome público);
    - `POST /vibes/:slug/view`: visitante único por dia (fuso de Brasília), identificado por um cookie aleatório `vg_vid` httpOnly guardado no banco como SHA-256, com CSRF e rate limit;
    - `GET|PUT|DELETE /me/favorites[/:vibeId]` e `GET /me/gets/:id` (só o dono);
    - o admin (produto, Vibe e `/admin/auctions`) aceita `brand`, `model`, `images` (até 10, mesma regra de host da capa), `specs` (até 40) e `benefits` (até 8).
  - **Bug antigo corrigido:** `escapeLike` (lib/pagination) gerava o texto literal `${c}`, e toda busca com `%` ou `_` voltava vazia, inclusive nas buscas do admin.
  - Testes novos: `tests/vibe-page.test.ts` e `tests/vibes-browse.test.ts`. Suíte: 440/441; só o QA-22 aberto.
  - **Front:** `src/pages/Vibe.jsx` (`/vibes/:slug`):
    - galeria com miniaturas e setas do teclado;
    - AO VIVO com contagem regressiva;
    - maior Get, valor na loja e % abaixo;
    - Gets, visitas e favoritos;
    - favoritar e compartilhar (Web Share ou cópia do link);
    - painel de Get com valor, atalhos, turbinar com GetCoin, total na disputa, "X voltam em GetCoin", Pix, cartão ou saldo, e o acompanhamento do Pix;
    - benefícios, descrição, ficha técnica e últimos Gets;
    - botão fixo "Dar Get" no celular;
    - estados de em breve, encerrada, não encontrada, carregando e erro.
  - Os cartões de `/vibes` e o "Ver a Vibe" do dashboard agora abrem essa página.
  - O seed de demonstração tem marca, modelo e ficha técnica (`DEMO_DETAILS` em `seed.ts`).
- **2026-09-28 (banco de dev corrompido de novo — causa raiz)**
  - A causa era o `npm run dev` da API usar `tsx watch`: no Windows, cada arquivo editado faz o watch matar o processo sem deixar o PGlite fechar, e uma gravação interrompida corrompe o banco.
  - **Correção:** o `dev` agora é `tsx` sem watch. O modo com recarga automática virou `dev:watch`, **só para uso com `DATABASE_URL` (Postgres)**.
  - **REGRA:** com PGlite, pare a API com **Ctrl+C** no terminal dela (o servidor fecha o banco com segurança) e nunca edite o backend com a API rodando em watch.
  - O banco foi recriado; o corrompido está em `server/.data/pglite-corrompido-2026-09-28-b`. O usuário de teste foi recriado com a mesma senha.
- **2026-09-28 (builder, D11 + D12)** — Implementados: D11 (compra avulsa em `modules/purchases`, configurações `/admin/settings/getcoin`, `custom` em `GET /getcoin-packages`) e D12 (`modules/market/{core,service,routes}.ts`: anúncio com custódia `MARKET_ESCROW`, cancelamento com `MARKET_ESCROW_RETURN`, pedido com lock no anúncio, pagamento PIX/CARD/BALANCE integrado a `applyPaymentOutcome`/webhook/simulate/job de expiração, liquidação `MARKET_BUY` + `MARKETPLACE_SALE` − `MARKETPLACE_FEE`, PAID tardio estornado, admin com audit, receita de taxas no dashboard). Migração nova `0008_market.sql`. Resultado real: `npm run typecheck` sem erros; `npm test` → **25 arquivos, 446/447** (única falha: QA-22, pré-existente); `0008` aplicada com sucesso numa **cópia** do banco de dev (a API de dev estava rodando; não abri nem matei o PGlite de dev).
- **2026-09-28 (QA, D11–D12)** — `tests/d11-d12-qa.test.ts` com 65 testes: taxa (unidade e E2E, preço ímpar, 0% e 50%, taxa congelada no pedido), conservação de GetCoin (Σ carteiras + remaining + reservado) e invariantes dos dois livros-razão em todos os cenários, concorrência (compras e reservas paralelas, cancelamento contra FAILED/PAID), PAID/FAILED/expiração/PAID tardio/replay de webhook e simulate, BALANCE insuficiente, IDOR, regras, compra avulsa (preço do servidor, faixa, desligada, crédito único), RBAC/validação/audit das settings, privacidade da lista pública, LGPD. Ordem de locks revisada por leitura: todos os fluxos do marketplace travam o anúncio primeiro, depois pagamento/pedido, carteiras GetCoin e por fim carteiras R$ (em ordem de user_id); compra de pacote e Get com saldo usam GetCoin → R$. Não achei ciclo entre cancelamento e compra. Resultado real: `npm run typecheck` sem erros; `npm test` → **26 arquivos, 512 testes: 509 passando, 3 falhando** (QA-22, que já existia, e os novos QA-23 e QA-24). Nenhum código de `server/src` alterado.
- **2026-09-29 (front, Marketplace)**
  - **Migração aplicada:** a `0008` foi aplicada no banco de dev ao reiniciar a API. Os processos antigos foram encerrados à força; a API voltou sem erro, mas o certo continua sendo Ctrl+C.
  - **Teste ponta a ponta no navegador:** compra avulsa na tela Comprar; no marketplace, compra com BALANCE, compra com PIX + simulate, publicação de anúncio com o recibo da taxa e o Histórico.
  - **Nova tela `src/pages/dashboard/Market.jsx` (CSS `.mk-*` em `styles.css`):**
    - régua de resumo com menor preço, preço da loja, anúncios na vitrine e GetCoins do usuário;
    - anúncios em cartões com iniciais do vendedor, "Menor preço", % contra o preço da loja (`custom.unitPriceCents` de `/getcoin-packages`) e barra do que resta;
    - só o anúncio mais barato leva o botão dourado; a compra tem atalhos de quantidade e o valor da loja riscado;
    - a aba Vender tem formulário e recibo lado a lado, atalhos (tudo, metade, igualar o menor, preço da loja) e "Como funciona";
    - quantidades inteiras ("250", não "250,00");
    - corrigida a aba "Histórico", que quebrava de linha: `.auth-tabs` tinha só 2 colunas.
  - **Dados de teste no banco de dev** (senha `TestPassword123456`):
    - usuários `test1790681145378@`, `test_414434071@`, `marina.mk@` e `rafael.mk@` (todos `vibeget.test`, e-mail confirmado);
    - pacotes "Pacote 50" e "Pacote 200";
    - GetCoins e R$ 150 creditados pelo admin com o motivo "Teste visual do marketplace";
    - 6 anúncios e 2 pedidos pagos.

## 11. Próximos passos

1. ~~Builder: scaffold de `server/` e implementação completa da seção 7.~~ (feito, aguarda QA)
2. ~~QA: suíte de testes + revisão de segurança da seção 8.~~ (feito: 297 testes, 15 achados na seção 9)
3. ~~Builder: corrigir achados do QA~~ (feito em 2026-09-25; 297/297 verdes). Ordem original: **QA-01** (bloqueia gateway real), **QA-05**, **QA-04**, **QA-07**, **QA-06** (combinar com o front), depois os BAIXO. Os 9 testes que falham hoje são os critérios de aceite: corrigir até ficarem verdes, sem editar os testes. Cliente decide QA-09 e QA-14.
3.1. ~~QA: reverificar cada correção~~ (feito em 2026-09-25: 13 verificados, 0 reabertos, 1 achado novo, o QA-16). QA-02 (ordem de locks) e a concorrência real do QA-07 foram verificados por leitura; a prova de verdade exige Postgres (item 4).
3.1.1. ~~Builder: corrigir [QA-16]~~ (feito em 2026-09-25; 324/324 verdes). QA: reverificar. (contador de tentativas travado em 5 após interrupção). O teste `regression.test.ts › [QA-16]` é o critério de aceite.
3.2. ~~Cliente: decidir QA-09 e QA-14~~ (decidido: D1 e D2, implementados). Cliente ainda precisa **confirmar a interpretação do D1** (60 s de corte + 40 s de margem) e a regra "conta nova" dos cupons (criada depois do cupom).
3.2.1. ~~QA: suíte completa de D1–D5 e reverificação de QA-09/QA-14/QA-16~~ (feito: 69 testes novos; QA-09, QA-14 e QA-16 verificados).
3.2.2. Builder: corrigir [QA-17] (PAID depois do prazo atual da Vibe quando o `endsAt` é encurtado) e [QA-18] (ordem estável do livro-razão). Os testes que falham são o critério de aceite. Avaliar QA-19 (cache de settings com várias instâncias), QA-20 (storage de imagens para produção) e QA-21 (usar o `paid_at` do provedor na integração do gateway).
3.2.2. Front: usar `getsCloseAt` para bloquear o botão de Get; tratar `409 VIBE_CLOSING`; tela de configurações, cupons e cadastro de leilão com upload (`/uploads` já tem proxy no Vite).
3.2.3. Produção: guardar `UPLOAD_DIR` em volume persistente (ou trocar por storage de objetos) e definir backup; várias instâncias do app precisam do mesmo diretório. Anterior: O comportamento atual está descrito na seção 9.
3.2.4. **[QA-20] Produção — storage de imagens:** trocar o disco local (`UPLOAD_DIR`) por storage de objetos (S3/R2 ou equivalente) **atrás da mesma interface** de `modules/uploads/service.ts` (`storeImage` → URL pública; servir via CDN ou pelo próprio `/uploads` com os mesmos headers), para funcionar com várias instâncias e disco efêmero. Incluir **limpeza de órfãos**: imagens enviadas que nenhum `products.image_url` referencia depois de N horas. Até lá, `UPLOAD_DIR` precisa de volume persistente compartilhado e backup.
3.3.1. ~~**QA — D6–D9:** suíte completa~~ (feito em 2026-09-25: 18 testes novos; 17 verdes, 1 falha que abriu o QA-22; suíte total 430/431).
3.3.1.1. **Builder: corrigir [QA-22]** validando o payload normalizado do ViaCEP/BrasilAPI e usando o fallback quando a resposta 200 for malformada. O teste `d6-d9-qa.test.ts › [QA-22]` é o critério de aceite; não editar o teste.
3.3.1.2. **Builder: corrigir [QA-23]** (teto de pedidos pendentes no marketplace) **e [QA-24]** (anúncio de vendedor suspenso fora da vitrine, ou cancelado na suspensão). Os testes em `d11-d12-qa.test.ts` são o critério de aceite; não editar os testes.
3.3.2. **Front:** usar `/admin/settings/withdrawals` para os limites de saque (desvio da seção 3); tratar `409 CASH_BALANCE` na exclusão de conta.
3.3.3. **Produção — saque:** o ADMIN paga o Pix fora do sistema e depois aprova. Com gateway real, integrar o pagamento do saque (payout) e conciliação; definir se o limite diário deve ser por dia civil (America/Sao_Paulo) em vez de janela de 24 h.
3.3.4. **Cliente:** confirmar a interpretação "Vencidas = vitórias" (D9) e os valores iniciais de saque (R$ 10,00 mínimo; R$ 5.000,00 por dia).
3.4.1. ~~Aplicar a 0008 no banco de dev~~ (feito em 2026-09-29).
3.4.2. **QA — D11/D12:** corrida de vários compradores no mesmo anúncio (nunca `Σ pedidos > total`), conservação de GetCoin, replay de webhook/simulate de pedido, PAID tardio (sobre FAILED e depois do prazo), cancelamento com pendentes, taxa com arredondamento (`floor`), IDOR em pedidos/anúncios, privacidade do vendedor/comprador, limites de configuração.
3.4.3. **Cliente:** confirmar taxa de 10 %, faixa de preço por GetCoin (R$ 0,10 a R$ 10,00) e mínimo de anúncio (10 GetCoins).
3.3. Front (telas): fazer o refresh em single-flight (uma renovação por vez, compartilhada entre abas via BroadcastChannel) e, ao receber `409 REFRESH_RACE`, repetir o refresh uma vez (o cookie novo já chegou). Tratar `429 TOO_MANY_ATTEMPTS` na troca de senha e na exclusão de conta.
3.4. Produção: usuário de banco da aplicação sem UPDATE/DELETE/TRUNCATE em `getcoin_ledger`; configurar `TRUST_PROXY` conforme o proxy real; definir `IMAGE_HOSTS`; definir o prazo de retenção de `audit_logs` (LGPD, QA-15); avaliar CAPTCHA/backoff no login em vez de só o bloqueio duro (QA-10a); com gateway real, implementar outbox para os eventos `PROVIDER_REFUND_REQUESTED`/`PROVIDER_CHARGE_CANCEL_REQUESTED` (QA-01).
4. Validar com Postgres real (`DATABASE_URL`) antes de produção; rodar um teste de concorrência (Gets simultâneos gastando o mesmo GetCoin) contra Postgres.
5. Trocar `ConsoleMailer` por provedor real e o provedor de pagamento MOCK por gateway (mesma interface de `mockProvider` e webhook).
6. ~~Cliente precisa definir bônus~~ (D3: o ADMIN define em `/admin/settings`). Ainda pendente do cliente: preços reais dos 4 produtos estimados e se `goal_gets` encerra a Vibe.
7. ~~Telas `/login` e `/cadastro`~~ (feito em 2026-09-25, ver seção 13). Próximo no front:
   - 7.1 Dashboard completo: ~~home, perfil/endereço, troca de senha, Meus Gets, carteiras/saque e compra de GetCoins~~ (implementados; layout responsivo, onboarding de Meus Gets, estados vazios da carteira/compra e ícone de GetCoin revistos em 2026-09-25). Ainda faltam resgate de cupom (`/me/coupons/redeem`), exportação e exclusão (LGPD).
   - 7.2 Painel `/admin`: configurações (D3), cupons (D4), cadastro de leilão com upload (D5), usuários e audit log.
   - 7.3 Tela de Vibe (`/produto/:slug`) com o botão de Get, usando `getsCloseAt` e tratando `409 VIBE_CLOSING`.
   - 7.4 Refresh entre abas: hoje o single-flight vale só dentro de uma aba (`src/lib/api.js`); falta sincronizar entre abas com BroadcastChannel (item 3.3).
   - 7.5 Rodar o documentador do Impeccable para alinhar o `DESIGN.md` aos tokens reais de `:root` em `src/styles.css`. O desvio já existia antes; o DESIGN.md também não registra as peças novas: folha de acesso, campo em pílula de vidro e tinta de erro em ember.
   - 7.6 Deploy do front: rotas SPA precisam de fallback para `index.html`; as telas novas usam caminhos absolutos (`/img/...`), então o site precisa ficar na raiz do domínio.

## 12. Como rodar

```bash
cd server
npm install
cp .env.example .env          # preencha SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD
npm run db:migrate            # aplica ./drizzle (PGlite em ./.data/pglite se DATABASE_URL vazio)
npm run db:seed               # admin + configurações iniciais (idempotente)
npm run db:seed:demo          # + 8 produtos FICTÍCIOS e Vibes de exemplo (recusado em produção)
npm run dev                   # tsx watch -> http://localhost:3333/api/v1/health
npm test                      # vitest, PGlite em memória (não precisa de banco)
npm run typecheck             # tsc --noEmit
npm run build && npm start    # compila para dist/ e roda com node
npm run db:generate           # após mudar src/db/schema.ts, gera nova migração SQL em ./drizzle
```

Observações:
- **PGlite não aceita dois processos no mesmo diretório**: pare o `npm run dev` antes de rodar `db:migrate`/`db:seed`. O `dev` já aplica as migrações no boot quando usa PGlite.
- Front: `npm run dev` na raiz (Vite em :5173) repassa `/api` para `:3333`.
- Logs em dev usam `pino-pretty` (devDependency). Os links de verificação de e-mail e de reset de senha aparecem no console do servidor (`[mailer:dev]`); em produção não são registrados.
- Testes: `tests/helpers.ts` expõe `createTestApp()` (PGlite em memória + migrações + `MemoryMailer` com `sent[]`/`last()`), `createUser`, `userWithToken`, `login`, `createLiveVibe`, `CSRF`, `bearer`. O rate limit vem desligado nos testes; `createTestApp({ rateLimit: true })` liga.

**Variáveis de ambiente** (`server/.env.example`):

| Variável | Padrão | Observação |
| --- | --- | --- |
| `NODE_ENV` | **sem padrão** | `development` \| `test` \| `production`. **Ausente = regras de produção** (exige `DATABASE_URL`, sem simulação de pagamento, segredos de dev nunca usados; segredos ausentes viram aleatórios efêmeros e o boot avisa). O `.env.example` já traz `development` |
| `HOST` / `PORT` | `127.0.0.1` / `3333` | |
| `LOG_LEVEL` | `info` | |
| `TRUST_PROXY` | `false` | IP do cliente para rate limit e audit. `false`: ignora `X-Forwarded-For` (atrás de proxy todos dividem o mesmo balde de rate limit). `1`, `2`…: confia nos N proxies mais próximos. `10.0.0.0/8,…`: confia só nesses IPs/CIDRs (recomendado). `true`: qualquer proxy (só se ele **sobrescreve** o header). Ver QA-03 |
| `DATABASE_URL` | vazio | vazio = PGlite; **obrigatório em produção** |
| `PGLITE_DATA_DIR` | `./.data/pglite` | |
| `AUTO_MIGRATE` | `true` | migra no boot (só com PGlite) |
| `JWT_SECRET` | segredo fixo de dev (só development/test) | **32+ caracteres em produção** |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `REFRESH_REUSE_GRACE_SECONDS` | `15` | refresh concorrente que chegou antes da rotação recebe `409 REFRESH_RACE` (não revoga a família) dentro dessa janela |
| `COOKIE_SECURE` | `true` | precisa ser `true` em produção |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | também é a allowlist de Origin do CSRF |
| `IMAGE_HOSTS` | vazio | hosts aceitos em `imageUrl` https de produtos. Vazio: dev/test aceitam qualquer host; produção só caminhos `/relativos` |
| `APP_URL` | `http://localhost:5173` | base dos links de e-mail (`/verificar-email?token=`, `/redefinir-senha?token=`) |
| `WELCOME_BONUS_CENTS` | `0` | **valor inicial** (D3) do bônus do Nível Explorador; depois vale `/admin/settings` |
| `REFERRAL_BONUS_CENTS` | `0` | **valor inicial** (D3); pago quando o indicado confirma o e-mail |
| `GET_CUTOFF_SECONDS` | `60` | **valor inicial** (D1/D3) do corte de Gets antes do fim (0–3600) |
| `PAYMENT_GRACE_SECONDS` | `40` | **valor inicial** (D1/D3) da margem de pagamento após o corte (0–corte) |
| `DEFAULT_CASHBACK_PERCENT` | `40` | **valor inicial** (D3) do cashback das Vibes novas |
| `UPLOAD_DIR` | `./uploads` | (D5) pasta das imagens, gitignored, servida em `/uploads` |
| `UPLOAD_MAX_BYTES` | `5000000` | (D5) tamanho máximo do upload (10 KB–20 MB) |
| `WITHDRAW_MIN_CENTS` | `1000` | **valor inicial** (D6) do saque mínimo; depois vale `/admin/settings/withdrawals` |
| `GETCOIN_UNIT_PRICE_CENTS` / `GETCOIN_CUSTOM_MIN_CENTS` / `GETCOIN_CUSTOM_MAX_CENTS` / `GETCOIN_CUSTOM_ENABLED` | `100` / `1000` / `100000` / `true` | **valores iniciais** (D11); depois vale `/admin/settings/getcoin` |
| `MARKET_FEE_PERCENT` / `MARKET_MIN_UNIT_PRICE_CENTS` / `MARKET_MAX_UNIT_PRICE_CENTS` / `MARKET_MIN_LISTING_CENTS` / `MARKET_ENABLED` | `10` / `10` / `1000` / `1000` / `true` | **valores iniciais** (D12); depois vale `/admin/settings/market` |
| `WITHDRAW_DAILY_MAX_CENTS` | `500000` | **valor inicial** (D6) do máximo de saque em 24 h |
| `TERMS_VERSION` | `2026-09` | gravada no aceite |
| `PAYMENT_WEBHOOK_SECRET` | segredo fixo de dev (só development/test) | **32+ caracteres em produção** |
| `PAYMENT_TTL_MINUTES` | `30` | pagamento pendente expira e devolve GetCoin |
| `JOBS_INTERVAL_MS` | `60000` | `0` desliga os jobs |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | vazio | sem eles o seed não cria admin |

## 13. Front: telas de acesso (2026-09-25)

Decisões do usuário:
- **Cadastro curto:** nome, e-mail, senha e aceite dos termos. CPF, celular e nascimento são pedidos antes do primeiro Get.
- **Destino depois de entrar:** `/dashboard` provisório.
- **Cupom e indicação:** campo recolhido "Tenho um cupom ou código de indicação", aberto e preenchido automaticamente por `?cupom=` e `?ref=`.

| Arquivo | Papel |
| --- | --- |
| `src/main.jsx` | Rotas (react-router-dom 7): `/`, `/login`, `/cadastro`, `/redefinir-senha`, `/verificar-email`, `/dashboard` (protegida) |
| `src/lib/api.js` | Cliente da API. Access token só em memória. Refresh por cookie, com uma renovação por vez e nova tentativa em `409 REFRESH_RACE`. Todas as chamadas levam `X-Requested-With: fetch` e `credentials: 'include'` |
| `src/lib/auth.jsx` | `AuthProvider` (restaura a sessão pelo cookie ao abrir), `RequireAuth` e `safeNext` (só aceita destino interno, bloqueia open redirect) |
| `src/pages/Auth.jsx` | Entrar, criar conta, recuperar senha (dentro do painel), redefinir senha e confirmar e-mail |
| `src/pages/Dashboard.jsx` | Provisório: saldo, nível, próximos passos (confirmar e-mail, dados antes do 1º Get) e últimas movimentações |
| `src/styles.css` (fim) | Seções "Acesso" e "Dashboard provisório" |

Detalhes:
- **Links da home:** "Entrar" e "Criar conta" em `src/App.jsx` agora apontam para `/login` e `/cadastro`; antes iam para vibeget.net.
- **Erros:** vêm do servidor em pt-BR; os de validação aparecem no campo certo (`details[].path`).
- **Bônus de boas-vindas:** a tela não promete, porque o padrão é 0 e quem define é o admin (D3).
- **Cadastro em 2 passos**, a pedido do usuário, para o painel não ficar alto:
  - Passo 1 "Seus dados": nome e e-mail.
  - Passo 2 "Sua senha": senha, cupom/indicação e termos, com a linha "Conta para <e-mail> · Alterar".
  - Erro do servidor em `name` ou `email`, ou `ACCOUNT_EXISTS`, volta ao passo 1.
  - Ao trocar de passo, o foco vai para o primeiro campo.
  - Um campo oculto `autocomplete="username"` no passo 2 deixa o gerenciador de senhas associar a senha ao e-mail.
- **Faixa de garantias:** substituiu a lista solta à esquerda. É um painel de vidro com 3 colunas (Lacrados / Pix ou cartão / 40% de volta), que vira linhas abaixo de 1180px.
- **Como rodar:** `server` com `npm run dev` e, na raiz, `npm run dev` (Vite em 5173, com proxy de `/api` para 3333).
