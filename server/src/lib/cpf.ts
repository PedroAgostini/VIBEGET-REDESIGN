/** Remove máscara e valida os dígitos verificadores do CPF. Retorna os 11 dígitos ou null. */
export function normalizeCpf(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  if (digits.length !== 11) return null
  if (/^(\d)\1{10}$/.test(digits)) return null
  const nums = digits.split('').map(Number)
  const dv = (len: number) => {
    let sum = 0
    for (let i = 0; i < len; i++) sum += nums[i]! * (len + 1 - i)
    const r = (sum * 10) % 11
    return r === 10 ? 0 : r
  }
  if (dv(9) !== nums[9] || dv(10) !== nums[10]) return null
  return digits
}

export const isValidCpf = (input: string) => normalizeCpf(input) !== null

/** Idade completa em anos numa data de referência (birthDate em YYYY-MM-DD). */
export function ageOn(birthDate: string, ref: Date = new Date()): number {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number]
  let age = ref.getUTCFullYear() - y
  const beforeBirthday = ref.getUTCMonth() + 1 < m || (ref.getUTCMonth() + 1 === m && ref.getUTCDate() < d)
  if (beforeBirthday) age--
  return age
}
