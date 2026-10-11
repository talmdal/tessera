import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  root: __dirname,

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
