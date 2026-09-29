import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: { '/api': 'http://localhost:3333', '/uploads': 'http://localhost:3333' },
    // O backend tem o próprio servidor; observar server/ (inclusive o banco PGlite) só prende arquivos no Windows.
    watch: { ignored: ['**/server/**'] },
  },
})
