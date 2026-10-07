/**
 * Senhas comuns (mín. 10 caracteres é exigido; a lista cobre as mais vazadas e variações pt-BR).
 * A checagem é feita em minúsculas e também contra a senha sem dígitos/símbolos finais.
 */
const LIST = [
  '1234567890', '12345678910', '0123456789', '0987654321', '1122334455', '1111111111', '0000000000',
  '1234512345', '1q2w3e4r5t', '1qaz2wsx3edc', 'qwertyuiop', 'qwerty1234', 'qwerty12345', 'asdfghjkl',
  'asdfghjkl1', 'zxcvbnm123', 'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssw0rd', 'p@ssword123', 'iloveyou', 'iloveyou123', 'welcome123', 'welcome1234',
  'letmein123', 'admin12345', 'admin123456', 'administrator', 'administrador', 'changeme', 'changeme123',
  'football', 'baseball', 'superman', 'batman123', 'princess', 'sunshine', 'sunshine1', 'starwars',
  'trustno1', 'whatever', 'dragon1234', 'monkey1234', 'master1234', 'shadow1234', 'michael123',
  'senha', 'senha123', 'senha1234', 'senha12345', 'senha123456', 'minhasenha', 'minhasenha123',
  'mudar123', 'mudar12345', 'trocar123', 'brasil', 'brasil123', 'brasil2026', 'flamengo', 'flamengo123',
  'corinthians', 'corinthians123', 'palmeiras', 'palmeiras123', 'saopaulo', 'saopaulo123', 'vasco123',
  'gremio123', 'cruzeiro123', 'santos123', 'botafogo123', 'internacional', 'eusouforte', 'teamo123',
  'amor123456', 'jesus12345', 'jesuscristo', 'deusefiel', 'deuseamor', 'vibeget', 'vibeget123',
  'vibeget2026', 'getcoin123', 'leilao123', 'abcdefghij', 'abcd123456', 'abc1234567', 'aaaaaaaaaa',
  'qwertyqwerty', 'computador', 'computer123', 'internet123', 'estrela123', 'familia123', 'felicidade',
  'naruto1234', 'pokemon123', 'minecraft1', 'minecraft123', 'fortnite123',
]

const COMMON = new Set(LIST)

export function isCommonPassword(password: string): boolean {
  const p = password.toLowerCase()
  if (COMMON.has(p)) return true
  const stripped = p.replace(/[\d\W_]+$/u, '')
  if (stripped.length > 0 && COMMON.has(stripped)) return true
  // sequência de um único caractere repetido
  if (/^(.)\1+$/u.test(p)) return true
  return false
}
