import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../../shared'),
      '@core': path.resolve(__dirname, '../../core'),
      '@shell': path.resolve(__dirname, '..'),
      '@plugins': path.resolve(__dirname, '../../plugins'),
      '@extensions': path.resolve(__dirname, '../../extension-registry')
    }
  },

  ssr: {
    resolve: {
      // @ts-ignore - Vite runtime supports this, TS types do not
      alias: {
        '@shared': path.resolve(__dirname, '../../shared'),
        '@core': path.resolve(__dirname, '../../core'),
        '@shell': path.resolve(__dirname, '..'),
        '@plugins': path.resolve(__dirname, '../../plugins'),
        '@extensions': path.resolve(__dirname, '../../extension-registry')
      }
    }
  },

  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'app.ts'),
      output: {
        entryFileNames: 'app.js',
        format: 'es'
      }
    }
  }
})
