// Níveis do produto (PRODUCT.md): Explorador no cadastro, Viber após o primeiro Champion Get.
export const LEVELS = {
  EXPLORADOR: { n: 1, label: 'Explorador' },
  VIBER: { n: 2, label: 'Viber' },
}

export const levelOf = (level) => LEVELS[level] ?? LEVELS.EXPLORADOR
