import { describe, it, expect } from 'vitest'
import type { AppAPI } from '../../shared/ipc'

describe('IPC contract', () => {
  it('defines the expected API surface', () => {
    const api: AppAPI = {
      getVersion: async () => 'x'
    }

    expect(api.getVersion).toBeDefined()
  })
})
