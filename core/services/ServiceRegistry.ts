// core/services/ServiceRegistry.ts
import { Disposable } from '../ports'

interface Registration {
  provider: string
  impl: unknown
}

/**
 * Services are objects with behaviour that one plugin provides and others
 * call, e.g. "vault.store". Each id has exactly one provider at a time.
 */
export class ServiceRegistry {
  private services = new Map<string, Registration>()

  provide(provider: string, id: string, impl: unknown): Disposable {
    const existing = this.services.get(id)
    if (existing) throw new Error(`Service "${id}" is already provided by "${existing.provider}"`)
    if ((typeof impl !== 'object' && typeof impl !== 'function') || impl === null) {
      throw new Error(`Service "${id}" must be an object or function`)
    }

    const registration = { provider, impl }
    this.services.set(id, registration)
    return {
      dispose: () => {
        if (this.services.get(id) === registration) this.services.delete(id)
      }
    }
  }

  has(id: string) {
    return this.services.has(id)
  }

  /** Throws if the service is not available. */
  get<T = unknown>(id: string): T {
    const registration = this.services.get(id)
    if (!registration) throw new Error(`Service not available: ${id}`)
    return registration.impl as T
  }

  providerOf(id: string): string | undefined {
    return this.services.get(id)?.provider
  }
}
