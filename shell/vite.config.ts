import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@tessera/types': path.resolve(__dirname, '../tessera-types/index.ts'),
      '@tessera/types/*': path.resolve(__dirname, '../tessera-types/*'),

      '@core': path.resolve(__dirname, '../core'),
      '@shared': path.resolve(__dirname, '../shared'),
      '@plugins': path.resolve(__dirname, '../plugins')
    }
  }
})
