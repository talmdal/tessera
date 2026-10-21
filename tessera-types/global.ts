import type { TesseraBridge } from '.'

declare global {
  interface Window {
    api: TesseraBridge
  }
}

export {}
