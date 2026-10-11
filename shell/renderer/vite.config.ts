import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  root: __dirname,
  plugins: [react()],

  server: {
    port: 5173,
    strictPort: true
  },

  build: {
    outDir: path.resolve(__dirname, '../../dist'),
    emptyOutDir: false
  }
})
