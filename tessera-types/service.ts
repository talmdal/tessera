import { Disposable } from "."
export interface ServiceRegistration {
  provider: string
  impl: unknown
}

/**
 * Services are objects with behaviour that one plugin provides and others
 * call, e.g. "vault.store". Each id has exactly one provider at a time.
 */
export interface ServiceRegistry {
  provide(provider: string, id: string, impl: unknown): Disposable 
  has(id: string): boolean
  /** Throws if the service is not available. */
  get<T = unknown>(id: string): T
  providerOf(id: string): string | undefined
}
