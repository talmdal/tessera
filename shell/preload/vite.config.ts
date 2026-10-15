import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '..'),
      '@core': path.resolve(__dirname, '../../core'),
      '@shell': path.resolve(__dirname, '..'),
      '@plugins': path.resolve(__dirname, '../../plugins'),
      '@extensions': path.resolve(__dirname, '../../extension-registry')
    }
  },
  build: {
    ssr: true,
    outDir: path.resolve(__dirname, '../../dist'),
    emptyOutDir: false,

    rollupOptions: {
      input: path.resolve(__dirname, 'preload.ts'),
      output: {
        entryFileNames: 'preload.js',
        format: 'cjs'
      }
    },

    target: 'node20'
  }
})
