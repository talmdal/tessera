import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@tessera/types': path.resolve(__dirname, '../tessera-types/index.ts'),
      '@tessera/types/*': path.resolve(__dirname, '../tessera-types/*'),

      '@shared': path.resolve(__dirname, '../shared'),
      '@shell': path.resolve(__dirname, '../shell'),
      '@plugins': path.resolve(__dirname, '../plugins')
    }
  }
})
