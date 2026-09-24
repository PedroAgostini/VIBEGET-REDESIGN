// Catálogo espelhado de vibeget.net. Tempos e contagens de Gets são ilustrativos.
const h = 3600 * 1000
const now = Date.now()

export const vibes = [
  {
    slug: 'iphone-15-pro-max-256gb',
    name: 'iPhone 15 Pro Max 256GB',
    category: 'smartphones',
    img: './img/iphone.jpg',
    current: 307,
    original: 9999,
    cashback: 5,
    endsAt: now + 2 * h + 14 * 60 * 1000,
    gets: 412,
    goal: 480,
  },
  {
    slug: 'samsung-galaxy-s24-ultra',
    name: 'Samsung Galaxy S24 Ultra',
    category: 'smartphones',
    img: './img/s24.jpg',
    dark: true,
    current: 307,
    original: 8999,
    cashback: 5,
    endsAt: now + 9 * h + 41 * 60 * 1000,
    gets: 268,
    goal: 450,
  },
  {
    slug: 'google-pixel-8-pro',
    name: 'Google Pixel 8 Pro',
    category: 'smartphones',
    img: './img/pixel.webp',
    current: 307,
    original: 6999,
    cashback: 5,
    endsAt: now + 26 * h + 3 * 60 * 1000,
    gets: 131,
    goal: 350,
  },
  {
    slug: 'asus-rog-zephyrus-g16',
    name: 'ASUS ROG Zephyrus G16',
    category: 'notebooks',
    img: './img/rog.jpg',
    current: 200.5,
    original: 14999,
    cashback: 7,
    endsAt: now + 51 * h + 27 * 60 * 1000,
    gets: 96,
    goal: 600,
  },
]

// Itens do catálogo sem foto publicada: aparecem só no ticker.
export const tickerExtra = [
  { name: 'MacBook Pro M3 14"', current: 200.5, cashback: 7 },
  { name: 'Xiaomi 14 Pro', current: 307, cashback: 5 },
  { name: 'Dell XPS 15', current: 200.5, cashback: 7 },
  { name: 'Lenovo ThinkPad X1 Carbon', current: 200.5, cashback: 7 },
]

export const categories = [
  { id: 'todos', label: 'Todas' },
  { id: 'smartphones', label: 'Smartphones' },
  { id: 'notebooks', label: 'Notebooks' },
  { id: 'games', label: 'Games' },
  { id: 'audio', label: 'Áudio' },
  { id: 'wearables', label: 'Wearables' },
]

export const brl = (v) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export const num = (v) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
