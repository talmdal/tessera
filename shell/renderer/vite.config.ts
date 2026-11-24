import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const pathName = import.meta.dirname

export default defineConfig({
  root: pathName,
  plugins: [react()],

  server: {
    port: 5173,
    strictPort: true
  },
  resolve: {
    alias: {
      '@shared': path.resolve(pathName, '../../shared'),
      '@tessera/types': path.resolve(pathName, '../../tessera-types/index.ts'),
      // Before @tessera/ui, which would otherwise match it as a prefix
      '@tessera/ui/charts': path.resolve(pathName, '../../tessera-ui/charts/index.ts'),
      '@tessera/ui': path.resolve(pathName, '../../tessera-ui/index.ts')
    }
  },
  build: {
    outDir: path.resolve(pathName, '../../dist'),
    emptyOutDir: false
  }
})
