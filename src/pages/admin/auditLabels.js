// Rótulos em português do audit log (códigos gravados pela API em `audit_logs.action` e `.entity`).

export const AREAS = {
  user: 'Contas',
  auth: 'Login',
  session: 'Sessões',
  vibe: 'Vibes',
  product: 'Produtos',
  get: 'Gets',
  payment: 'Pagamentos',
  purchase: 'Compras de GetCoin',
  package: 'Pacotes',
  coupon: 'Cupons',
  withdrawal: 'Saques',
  prize: 'Prêmios',
  market_listing: 'Anúncios do marketplace',
  market_order: 'Pedidos do marketplace',
  settings: 'Configurações',
}

/** código → [rótulo, área] (a área agrupa o seletor de ações). */
export const ACTIONS = {
  USER_REGISTERED: ['Conta criada', 'user'],
  EMAIL_VERIFIED: ['E-mail confirmado', 'user'],
  PROFILE_UPDATED: ['Perfil atualizado', 'user'],
  ADDRESS_UPDATED: ['Endereço atualizado', 'user'],
  PASSWORD_CHANGED: ['Senha alterada', 'user'],
  PASSWORD_CHANGE_FAILED: ['Troca de senha recusada (senha atual errada)', 'user'],
  PASSWORD_RESET_REQUESTED: ['Pediu redefinição de senha', 'user'],
  PASSWORD_RESET: ['Senha redefinida', 'user'],
  ACCOUNT_LOCKED: ['Conta bloqueada por tentativas erradas', 'user'],
  ACCOUNT_DELETE_FAILED: ['Exclusão de conta recusada (senha errada)', 'user'],
  ACCOUNT_DELETED: ['Conta excluída (LGPD)', 'user'],
  USER_UPDATED: ['Acesso alterado pela equipe', 'user'],
  WALLET_ADJUSTED: ['Ajuste de GetCoin pela equipe', 'user'],
  CASH_ADJUSTED: ['Ajuste de saldo em R$ pela equipe', 'user'],
  MARKET_LISTINGS_CANCELLED_ON_SUSPEND: ['Anúncios cancelados pela suspensão', 'user'],
  LOGIN_SUCCEEDED: ['Entrou na conta', 'user'],
  LOGIN_FAILED: ['Login com senha errada', 'auth'],
  LOGIN_BLOCKED: ['Login bloqueado', 'auth'],
  LOGOUT_ALL: ['Saiu de todos os aparelhos', 'user'],
  REFRESH_TOKEN_REUSE: ['Sessão reutilizada (possível vazamento): sessões encerradas', 'session'],
  PRODUCT_CREATED: ['Produto cadastrado', 'product'],
  PRODUCT_UPDATED: ['Produto editado', 'product'],
  IMAGE_UPLOADED: ['Foto enviada', 'product'],
  AUCTION_CREATED: ['Leilão cadastrado', 'vibe'],
  VIBE_CREATED: ['Vibe criada', 'vibe'],
  VIBE_UPDATED: ['Vibe editada', 'vibe'],
  VIBE_CANCELLED: ['Vibe cancelada (Gets estornados)', 'vibe'],
  VIBE_SETTLED: ['Vibe encerrada (vencedor e cashback)', 'vibe'],
  PAYMENT_PAID: ['Pagamento confirmado', 'payment'],
  PAYMENT_FAILED: ['Pagamento não concluído', 'payment'],
  PAYMENT_LATE_REFUND: ['Pagamento atrasado estornado', 'payment'],
  PROVIDER_REFUND_REQUESTED: ['Estorno pedido ao provedor', 'payment'],
  PROVIDER_CHARGE_CANCEL_REQUESTED: ['Cancelamento de cobrança pedido ao provedor', 'payment'],
  GETCOIN_PURCHASE_CREATED: ['Compra de GetCoin iniciada', 'purchase'],
  PACKAGE_CREATED: ['Pacote criado', 'package'],
  PACKAGE_UPDATED: ['Pacote editado', 'package'],
  PACKAGE_DELETED: ['Pacote excluído', 'package'],
  COUPON_CREATED: ['Cupom criado', 'coupon'],
  COUPON_UPDATED: ['Cupom editado', 'coupon'],
  COUPON_REDEEMED: ['Cupom resgatado', 'coupon'],
  COUPON_REDEEM_FAILED: ['Resgate de cupom recusado', 'user'],
  WITHDRAWAL_REQUESTED: ['Saque pedido', 'withdrawal'],
  WITHDRAWAL_APPROVED: ['Saque pago', 'withdrawal'],
  WITHDRAWAL_REJECTED: ['Saque recusado', 'withdrawal'],
  PRIZE_ADDRESS_CONFIRMED: ['Endereço de entrega confirmado', 'prize'],
  PRIZE_ADDRESS_CHANGED: ['Endereço de entrega alterado', 'prize'],
  PRIZE_SHIPPED: ['Prêmio enviado', 'prize'],
  PRIZE_TRACKING_UPDATED: ['Rastreio corrigido', 'prize'],
  PRIZE_DELIVERED: ['Prêmio entregue', 'prize'],
  MARKET_LISTING_CREATED: ['Anúncio publicado', 'market_listing'],
  MARKET_LISTING_CANCELLED: ['Anúncio cancelado pelo vendedor', 'market_listing'],
  MARKET_LISTING_CANCELLED_BY_ADMIN: ['Anúncio cancelado pela equipe', 'market_listing'],
  MARKET_ORDER_CREATED: ['Pedido no marketplace', 'market_order'],
  SETTINGS_UPDATED: ['Configurações alteradas', 'settings'],
}

export const actionLabel = (code) => ACTIONS[code]?.[0] ?? code

/** Onde abrir o registro afetado no painel (quando existe uma tela para ele). */
export function entityLink(entity, id) {
  if (!id) return null
  if (entity === 'user') return `/admin/usuarios/${id}`
  if (entity === 'vibe') return `/admin/vibes/${id}/editar`
  return null
}
