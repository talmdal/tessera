import { defineConfig } from 'vite'
import path from 'node:path'

const pathName = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(pathName, '../../shared'),
      '@core': path.resolve(pathName, '../../core'),
      '@shell': path.resolve(pathName, '..'),
      '@plugins': path.resolve(pathName, '../../plugins'),
      '@extensions': path.resolve(pathName, '../../extension-registry'),
      '@tessera/types': path.resolve(pathName, '../../tessera-types/index.ts'),
      '@tessera/types/*': path.resolve(pathName, '../../tessera-types/*'),
    }
  },

  ssr: {
    resolve: {
      // @ts-ignore - Vite runtime supports this, TS types do not
      alias: {
        '@shared': path.resolve(pathName, '../../shared'),
        '@core': path.resolve(pathName, '../../core'),
        '@shell': path.resolve(pathName, '..'),
        '@plugins': path.resolve(pathName, '../../plugins'),
        '@extensions': path.resolve(pathName, '../../extension-registry'),
        '@tessera/types': path.resolve(pathName, '../../tessera-types/index.ts'),
        '@tessera/types/*': path.resolve(pathName, '../../tessera-types/*'),
      }
    }
  },
  optimizeDeps: {
    exclude: ['lokijs']
  },
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(pathName, 'app.ts'),
      external: ['lokijs'],
      output: {
        entryFileNames: 'app.js',
        format: 'cjs'
      }
    }
  }
})
