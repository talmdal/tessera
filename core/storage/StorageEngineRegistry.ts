import { StorageEngine } from '@tessera/types'

export class StorageEngineRegistry {
  private engines: Map<string, () => StorageEngine> = new Map()

  register(name: string, factory: () => StorageEngine) {
    this.engines.set(name, factory)
  }

  create(name: string): StorageEngine {
    const factory = this.engines.get(name)
    if (!factory) throw new Error(`Unknown storage engine: ${name}`)
    return factory()
  }

  list(): string[] {
    return [...this.engines.keys()]
  }
}
