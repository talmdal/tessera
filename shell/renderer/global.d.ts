import type { TesseraBridge } from '../../shared/ipc'

declare global {
  interface Window {
    api: TesseraBridge
  }
}

export {}
