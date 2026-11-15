// core/options/OptionsService.ts
import type { Disposable, Json, Logger, OptionsEntry, OptionsHandle, OptionsSpec } from '@tessera/types'
import type { OptionsStore } from '../ports'
import { cloneValue, diffValues, equalValues, isJsonObject, mergeValues } from '../../shared/options/values'

type Listener = (value: never, previous: never) => void

interface Registration {
  readonly namespace: string
  readonly defaults: Json
  readonly version: number
  readonly validate?: (value: never) => string[]
  /** The current complete value: stored overrides merged over the defaults. */
  value: Json
  /**
   * The stored entry was written by a newer version of the plugin than the one running. Its values are used as
   * they are, and never rewritten on the plugin's behalf, so old code cannot quietly destroy new data. An
   * explicit commit by the user still wins.
   */
  fromNewerVersion: boolean
  readonly listeners: Set<Listener>
}

export interface OptionsServiceOptions {
  log?: Logger
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

/** A stored entry, or undefined when the namespace is absent or its entry is malformed. */
function parseEntry(raw: Json | undefined): OptionsEntry | undefined {
  if (!isJsonObject(raw)) return undefined
  const { version, values } = raw
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
  if (values === undefined) return undefined
  return { version, values }
}

/**
 * The options service: every plugin's registered defaults, and the user's overrides laid over them.
 *
 * It is built by the shell before any plugin activates, from a store it reads synchronously, so `register` and
 * `get` are synchronous and a plugin can read its options the moment it activates. Only values that differ from
 * a plugin's defaults are stored; everything else comes from the defaults, which keeps the file small and lets
 * a plugin update change a default for everyone who never overrode it.
 *
 * Nothing here ever throws because of what is on disk: a damaged file, a damaged entry, a value from a newer
 * version of a plugin and a value that fails validation all fall back to the defaults and log. See
 * docs/options-framework-design.md.
 */
export class OptionsService {
  private readonly registrations = new Map<string, Registration>()
  /** The document as it will be written: entries for namespaces nobody has registered are kept untouched. */
  private readonly document: Record<string, Json>
  private readonly log?: Logger

  constructor(private readonly store: OptionsStore, options: OptionsServiceOptions = {}) {
    this.log = options.log
    this.document = { ...store.read() }
  }

  /**
   * Declares a namespace's options and returns a handle on its value. Called once per namespace, by the plugin
   * that owns it (through `context.options`) or by the shell for its own.
   */
  register<T>(namespace: string, spec: OptionsSpec<T>): OptionsHandle<T> {
    if (this.registrations.has(namespace)) throw new Error(`Options are already registered for "${namespace}"`)

    const version = spec.version ?? 1
    const defaults = cloneValue(spec.defaults as unknown as Json)
    const stored = this.document[namespace]
    const entry = parseEntry(stored)
    if (stored !== undefined && entry === undefined) {
      this.log?.warn(`[options] Ignoring the stored options for "${namespace}": the entry is malformed. Using the defaults.`)
    }

    let overrides: Json = {}
    let fromNewerVersion = false
    let migrated = false

    if (entry) {
      if (entry.version > version) {
        // A downgrade: the file was written by a newer version of this plugin. Use what it holds, but never
        // rewrite it on the plugin's behalf.
        fromNewerVersion = true
        overrides = entry.values
        this.log?.warn(`[options] The stored options for "${namespace}" were written by version ${entry.version}, newer than this plugin's ${version}. They will be used but not rewritten.`)
      } else if (entry.version < version && spec.migrate) {
        try {
          overrides = spec.migrate(cloneValue(entry.values), entry.version)
          migrated = true
        } catch (err) {
          this.log?.warn(`[options] Could not migrate the options for "${namespace}" from version ${entry.version}: ${describe(err)}. Using the defaults.`)
          overrides = {}
        }
      } else {
        overrides = entry.values
        migrated = entry.version < version      // no migrate function: the values carry over as they are
      }
    }

    let value = mergeValues(defaults, overrides)

    const problems = this.check(spec.validate, value, namespace, 'The stored options')
    if (problems.length > 0) {
      // The file is left exactly as it is: the user's values are not thrown away, they are just not used this
      // session. Committing from the dialog replaces them.
      this.log?.warn(`[options] The stored options for "${namespace}" are not valid (${problems.join('; ')}). Using the defaults for this session.`)
      value = defaults
      migrated = false
    }

    const registration: Registration = {
      namespace,
      defaults,
      version,
      validate: spec.validate as ((value: never) => string[]) | undefined,
      value,
      fromNewerVersion,
      listeners: new Set()
    }
    this.registrations.set(namespace, registration)

    // Writing the migrated value back now means a migration runs once, not at every start.
    if (migrated && !fromNewerVersion) this.persist(registration)

    return {
      get: () => cloneValue(registration.value) as unknown as T,
      onDidChange: listener => this.listen(registration, listener as Listener)
    }
  }

  /**
   * Forgets a namespace's registration. The stored values stay on disk, so a plugin that is deactivated and
   * activated again — or simply turned off for a session — finds its options where it left them.
   */
  unregister(namespace: string): void {
    const registration = this.registrations.get(namespace)
    if (!registration) return
    registration.listeners.clear()
    this.registrations.delete(namespace)
  }

  /** True once `register` has been called for this namespace. */
  has(namespace: string): boolean {
    return this.registrations.has(namespace)
  }

  /** Every registered namespace, in registration order. */
  namespaces(): string[] {
    return [...this.registrations.keys()]
  }

  /** The current complete value, or undefined when nothing has registered the namespace. */
  get<T = Json>(namespace: string): T | undefined {
    const registration = this.registrations.get(namespace)
    return registration && cloneValue(registration.value) as unknown as T
  }

  /** The registered defaults, or undefined when nothing has registered the namespace. */
  defaults<T = Json>(namespace: string): T | undefined {
    const registration = this.registrations.get(namespace)
    return registration && cloneValue(registration.defaults) as unknown as T
  }

  /**
   * Stores a namespace's value, after validating it. Returns the validation messages: an empty array means it
   * was saved. Nothing is written when validation fails.
   */
  commit<T>(namespace: string, value: T): string[] {
    const registration = this.required(namespace)
    const next = cloneValue(value as unknown as Json)

    const problems = this.check(registration.validate, next, namespace, 'The options')
    if (problems.length > 0) return problems

    if (registration.fromNewerVersion) {
      this.log?.warn(`[options] Replacing the options for "${namespace}" that a newer version of the plugin wrote, because the user saved this page.`)
      registration.fromNewerVersion = false
    }

    const previous = registration.value
    registration.value = next
    this.persist(registration)
    if (!equalValues(next, previous)) this.announce(registration, next, previous)
    return []
  }

  /** Puts a namespace back to its defaults, removing its stored entry. */
  reset(namespace: string): void {
    const registration = this.required(namespace)
    const previous = registration.value
    registration.value = cloneValue(registration.defaults)
    registration.fromNewerVersion = false
    this.persist(registration)
    if (!equalValues(registration.value, previous)) this.announce(registration, registration.value, previous)
  }

  /** Resolves once everything written so far has reached the disk. Called while shutting down. */
  async flush(): Promise<void> {
    await this.store.flush()
  }

  private required(namespace: string): Registration {
    const registration = this.registrations.get(namespace)
    if (!registration) throw new Error(`No options are registered for "${namespace}"`)
    return registration
  }

  /** Runs a plugin's `validate`. A `validate` that throws is a failure, not a crash. */
  private check(validate: ((value: never) => string[]) | undefined, value: Json, namespace: string, subject: string): string[] {
    if (!validate) return []
    try {
      const problems = validate(value as never)
      return Array.isArray(problems) ? problems.filter(problem => typeof problem === 'string') : []
    } catch (err) {
      this.log?.warn(`[options] ${subject} for "${namespace}" could not be validated: ${describe(err)}`)
      return [`Could not be validated: ${describe(err)}`]
    }
  }

  /** Writes the namespace's overrides into the document, and the document to the store. */
  private persist(registration: Registration): void {
    const overrides = diffValues(registration.value, registration.defaults)
    if (overrides === undefined) delete this.document[registration.namespace]
    else this.document[registration.namespace] = { version: registration.version, values: overrides }

    try {
      this.store.write({ ...this.document })
    } catch (err) {
      this.log?.error(`[options] Could not save the options for "${registration.namespace}"`, err)
    }
  }

  private listen(registration: Registration, listener: Listener): Disposable {
    registration.listeners.add(listener)
    return { dispose: () => { registration.listeners.delete(listener) } }
  }

  /** A listener that throws is logged, and the others still run. */
  private announce(registration: Registration, value: Json, previous: Json): void {
    for (const listener of [...registration.listeners]) {
      try {
        listener(cloneValue(value) as never, cloneValue(previous) as never)
      } catch (err) {
        this.log?.error(`[options] An options listener for "${registration.namespace}" failed`, err)
      }
    }
  }
}
