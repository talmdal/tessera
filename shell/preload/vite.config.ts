import { defineConfig } from 'vite'
import path from 'path'

const pathName = import.meta.dirname

export default defineConfig({
  root: pathName,
  resolve: {
    alias: {
      '@shared': path.resolve(pathName, '..'),
      '@core': path.resolve(pathName, '../../core'),
      '@shell': path.resolve(pathName, '..'),
      '@plugins': path.resolve(pathName, '../../plugins'),
      '@extensions': path.resolve(pathName, '../../extension-registry')
    }
  },
  build: {
    ssr: true,
    outDir: path.resolve(pathName, '../../dist'),
    emptyOutDir: false,

    rollupOptions: {
      input: path.resolve(pathName, 'preload.ts'),
      output: {
        entryFileNames: 'preload.js',
        format: 'cjs'
      }
    },

    target: 'node20'
  }
})
