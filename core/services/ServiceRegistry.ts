// core/services/ServiceRegistry.ts
import { Disposable, ServiceRegistry, ServiceRegistration } from '@tessera/types'

/**
 * Services are objects with behaviour that one plugin provides and others
 * call, e.g. "vault.store". Each id has exactly one provider at a time.
 */
export class ServiceRegistryImpl implements ServiceRegistry {
  private services = new Map<string, ServiceRegistration>()

  provide(provider: string, id: string, impl: unknown): Disposable {
    const existing = this.services.get(id)
    if (existing) throw new Error(`Service "${id}" is already provided by "${existing.provider}"`)
    if ((typeof impl !== 'object' && typeof impl !== 'function') || impl === null) {
      throw new Error(`Service "${id}" must be an object or function`)
    }

    const registration: ServiceRegistration = { provider, impl }
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
