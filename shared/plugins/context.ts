// shared/plugins/context.ts
import { IpcRouter } from '../ipcRouter'
import { Services } from './types'

export interface ExtensionContribution {
  id: string
  point: string
  impl: unknown
}

export class ExtensionRegistry {
  private contributions: ExtensionContribution[] = []

  register(point: string, id: string, impl: unknown) {
    this.contributions.push({ point, id, impl })
  }

  getContributions(point: string) {
    return this.contributions.filter(c => c.point === point)
  }
}

export class PluginContext {
  constructor(
    public readonly ipc: IpcRouter,
    public readonly extensions: ExtensionRegistry,
    public readonly services: Services
  ) {}
}
