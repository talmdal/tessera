// MUST be first
import './mockElectron'

import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Optional: add any global mocks here later, e.g. window.api
declare global {
  interface Window {
    app?: {
      getVersion: () => Promise<string>
    }
  }
}
