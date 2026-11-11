// core/settings/SettingsService.ts
import type {
  Disposable,
  ExtensionRegistry,
  JsonObject,
  Logger,
  SettingsChangeEvent,
  SettingsCommitResult,
  SettingsDefinition,
  SettingsHandle,
  SettingsNamespaceSnapshot,
  SettingsPageDescriptor,
  SettingsReader,
  SettingsRegistry
} from '@tessera/types'
import { SETTINGS_ID_PATTERN, SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import { fieldsProblems } from '../../shared/settings/fields'
import { resolveSettingsPages } from '../../shared/settings/resolvePages'
import {
  changedPaths, clone, deepEqual, deepFreeze, diffFromDefaults, getAtPath, isPlainObject, jsonProblem, mergeOverDefaults, setAtPath, shapeProblems
} from '../../shared/settings/values'
import type { SettingsPersistence, StoredSettings } from '../ports'

export interface SettingsOptions {
  /** Where `shell.settings.pages` are contributed; their fields are checked when a value is saved. */
  extensions?: ExtensionRegistry
  /** Where values are kept. Without it they last for the session. */
  persistence?: SettingsPersistence
  log?: Logger
}

type Listener = (event: SettingsChangeEvent) => void

interface Entry {
  id: string
  owner: string
  version: number
  defaults: JsonObject
  value: JsonObject
  migrate?: SettingsDefinition<JsonObject>['migrate']
  validate?: SettingsDefinition<JsonObject>['validate']
  /** Why the value can't be changed, when it can't. */
  readOnly?: string
  listeners: Set<Listener>
  disposed: boolean
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)
const owns = (owner: string, id: string) => id === owner || id.startsWith(`${owner}.`)

/** An error whose `problems` are the messages a change was refused with. */
function refused(id: string, problems: readonly string[]) {
  return Object.assign(new Error(`Settings "${id}" were not changed: ${problems.join(' ')}`), { problems: [...problems] })
}

/**
 * The settings of every plugin (and of the shell), one namespace each: the defaults its owner registers, with what
 * the user changed merged over them.
 *
 * What was saved is read once, before plugins activate (`load`), and checked as each namespace registers: a file in
 * an unexpected form, values that fail the owner's `validate`, or a migration that throws leave that namespace at its
 * defaults for the session (and its file untouched until the user changes something); a key of the wrong type falls
 * back to its default alone; values saved by a newer version of the plugin are used but can't be changed. None of
 * these stops anything starting.
 *
 * Changes come from the Options dialog (`commit`, every namespace or none) and from owners (`update`, `reset`), are
 * checked against the namespace's shape, its pages' fields and its `validate`, and are written one at a time, only
 * what differs from the defaults, so a default changed in a plugin update reaches users who never touched it.
 */
export class SettingsService implements SettingsRegistry {
  private readonly entries = new Map<string, Entry>()
  /** What is saved for each namespace, as loaded or last written, registered or not. */
  private readonly stored = new Map<string, unknown>()
  private readonly listeners = new Set<Listener>()
  private readonly pendingWrites = new Map<string, StoredSettings | undefined>()
  /** Why the last write of a namespace failed, until one succeeds. */
  private readonly failures = new Map<string, string>()
  private draining?: Promise<void>
  private diagnosed = ''

  constructor(private readonly options: SettingsOptions = {}) {}

  readonly onDidChange = (listener: Listener): Disposable => {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  async load() {
    let documents: Record<string, unknown> = {}
    try {
      documents = await this.options.persistence?.loadAll() ?? {}
    } catch (err) {
      this.options.log?.warn(`[settings] Could not read the saved settings; the defaults are used: ${describe(err)}`)
    }
    for (const [id, document] of Object.entries(documents)) this.stored.set(id, document)

    // Namespaces registered before the load take what was saved for them now.
    for (const entry of this.entries.values()) {
      const previous = entry.value
      this.readStored(entry)
      if (!deepEqual(previous, entry.value)) this.fire(entry, previous)
    }
  }

  register<T extends object>(owner: string, definition: SettingsDefinition<T>): SettingsHandle<T> & Disposable {
    if (typeof definition !== 'object' || definition === null) throw new Error(`"${owner}" registered settings without a definition`)
    const id = definition.id ?? owner
    const where = `Settings "${String(id)}"`

    if (typeof id !== 'string' || !SETTINGS_ID_PATTERN.test(id)) {
      throw new Error(`${where}: an id is lower-case words separated by dots, such as "${owner}" or "${owner}.general"`)
    }
    if (!owns(owner, id)) throw new Error(`"${owner}" cannot register settings "${id}": ids must be "${owner}" or start with "${owner}."`)
    if (this.entries.has(id)) throw new Error(`${where} are already registered by "${this.entries.get(id)!.owner}"`)

    const defaults = definition.defaults as unknown
    if (!isPlainObject(defaults)) throw new Error(`${where}: the defaults must be an object`)
    const notJson = jsonProblem(defaults, 'defaults')
    if (notJson) throw new Error(`${where}: ${notJson}`)
    const version = definition.version ?? 1
    if (!Number.isInteger(version) || version < 1) throw new Error(`${where}: the version must be a whole number from 1`)
    for (const hook of ['migrate', 'validate'] as const) {
      if (definition[hook] !== undefined && typeof definition[hook] !== 'function') throw new Error(`${where}: ${hook} must be a function`)
    }

    const entry: Entry = {
      id, owner, version,
      defaults: deepFreeze(clone(defaults as JsonObject)),
      value: {},
      migrate: definition.migrate as Entry['migrate'],
      validate: definition.validate as Entry['validate'],
      listeners: new Set(),
      disposed: false
    }
    entry.value = entry.defaults
    const problems = this.ownProblems(entry, entry.defaults)
    if (problems.length > 0) throw new Error(`${where}: the defaults fail their own validation: ${problems.join(' ')}`)

    this.readStored(entry)
    this.entries.set(id, entry)
    return this.handleFor(entry) as unknown as SettingsHandle<T> & Disposable
  }

  has(id: string) {
    return this.entries.has(id)
  }

  reader<T extends object = JsonObject>(id: string): SettingsReader<T> {
    if (typeof id !== 'string' || !SETTINGS_ID_PATTERN.test(id)) throw new Error(`"${String(id)}" is not a settings id`)
    return {
      id,
      // The value is frozen, so a reader can't change what the owner and other readers see.
      get: () => this.entries.get(id)?.value as T | undefined,
      onDidChange: listener => this.onDidChange(event => { if (event.id === id) (listener as Listener)(event) })
    }
  }

  snapshot(id: string): SettingsNamespaceSnapshot | undefined {
    const entry = this.entries.get(id)
    return entry && this.snapshotOf(entry)
  }

  snapshots(): SettingsNamespaceSnapshot[] {
    return [...this.entries.values()].map(entry => this.snapshotOf(entry))
  }

  pages(): SettingsPageDescriptor[] {
    const contributions = this.options.extensions?.getContributions(SETTINGS_PAGES_EXTENSION_POINT) ?? []
    const { pages, diagnostics } = resolveSettingsPages(contributions, id => {
      const entry = this.entries.get(id)
      return entry && { owner: entry.owner, defaults: entry.defaults }
    })
    // Pages are resolved often (each time the dialog opens, and on every change); say what is wrong once.
    const diagnosed = diagnostics.join('\n')
    if (diagnosed !== this.diagnosed) {
      this.diagnosed = diagnosed
      for (const message of diagnostics) this.options.log?.warn(`[settings] ${message}`)
    }
    return pages
  }

  async commit(changes: readonly { id: string, value: unknown }[]): Promise<SettingsCommitResult> {
    const errors: Record<string, string[]> = {}
    const accepted: { entry: Entry, value: JsonObject }[] = []
    const pages = this.pages()

    for (const change of Array.isArray(changes) ? changes : []) {
      const id = typeof change?.id === 'string' ? change.id : String(change?.id)
      const entry = this.entries.get(id)
      if (errors[id] || accepted.some(a => a.entry.id === id)) errors[id] = [`Settings "${id}" were changed twice at once.`]
      else if (!entry) errors[id] = [`There are no settings "${id}".`]
      else if (entry.readOnly) errors[id] = [entry.readOnly]
      else if (!isPlainObject(change.value)) errors[id] = [`Settings "${id}" must be an object.`]
      else {
        const notJson = jsonProblem(change.value)
        const value = notJson ? undefined : mergeOverDefaults(entry.defaults, clone(change.value as JsonObject))
        const problems = notJson ? [`Settings "${id}": ${notJson}.`] : this.problemsOf(entry, value!, pages)
        if (problems.length > 0) errors[id] = problems
        else accepted.push({ entry, value: value! })
      }
    }

    if (Object.keys(errors).length > 0) return { ok: false, errors }

    for (const { entry, value } of accepted) this.apply(entry, value)
    await this.flush()
    const saveError = accepted.map(({ entry }) => this.failures.get(entry.id)).find(failure => failure !== undefined)
    return {
      ok: true,
      namespaces: accepted.map(({ entry }) => this.snapshotOf(entry)),
      ...(saveError !== undefined && { saveError })
    }
  }

  flush(): Promise<void> {
    return this.draining ?? Promise.resolve()
  }

  // ---- Internals ----

  private handleFor(entry: Entry): SettingsHandle & Disposable {
    const change = async (value: JsonObject) => {
      if (entry.disposed) throw new Error(`Settings "${entry.id}" are no longer registered`)
      const result = await this.commit([{ id: entry.id, value }])
      if (!result.ok) throw refused(entry.id, result.errors[entry.id] ?? Object.values(result.errors).flat())
    }
    return {
      id: entry.id,
      defaults: entry.defaults,
      get: () => entry.value,
      update: patch => {
        if (!isPlainObject(patch)) return Promise.reject(new Error(`Settings "${entry.id}": update takes an object of the settings to change`))
        return change({ ...entry.value, ...patch as JsonObject })
      },
      reset: () => change(entry.defaults),
      onDidChange: listener => {
        entry.listeners.add(listener as Listener)
        return { dispose: () => { entry.listeners.delete(listener as Listener) } }
      },
      dispose: () => {
        entry.disposed = true
        entry.listeners.clear()
        if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      }
    }
  }

  /** Sets `entry.value` from what was saved for it, or from its defaults when that can't be used. */
  private readStored(entry: Entry) {
    const log = this.options.log
    const where = `[settings] Settings "${entry.id}"`
    const raw = this.stored.get(entry.id)
    entry.readOnly = undefined
    entry.value = entry.defaults
    if (raw === undefined) return

    const document = raw as Partial<StoredSettings>
    if (!isPlainObject(raw) || !Number.isInteger(document.version) || document.version! < 1 || !isPlainObject(document.values) || jsonProblem(document.values)) {
      log?.warn(`${where}: the saved file is not in the expected form; the defaults are used until the settings are changed`)
      return
    }

    let overrides: JsonObject = clone(document.values as JsonObject)
    const savedWith = document.version!
    if (savedWith > entry.version) {
      // A downgrade: what the newer version saved is used, but writing it back in the old shape would lose data.
      entry.readOnly = `These settings were saved by a newer version of "${entry.owner}", so they can't be changed here.`
      log?.warn(`${where} were saved by version ${savedWith} of their shape, and "${entry.owner}" knows version ${entry.version}; they are read-only`)
    } else if (savedWith < entry.version && entry.migrate) {
      try {
        const migrated = entry.migrate(clone(overrides), savedWith)
        const problem = isPlainObject(migrated) ? jsonProblem(migrated, 'the migrated value') : 'the migration did not return an object'
        if (problem) throw new Error(problem)
        overrides = clone(migrated as JsonObject)
      } catch (err) {
        log?.warn(`${where} could not be upgraded from version ${savedWith}: ${describe(err)}; the defaults are used until the settings are changed`)
        return
      }
    }

    let value = mergeOverDefaults(entry.defaults, overrides)
    for (const { path, problem } of shapeProblems(entry.defaults, value)) {
      log?.warn(`${where}: ${problem}; its default is used`)
      value = setAtPath(value, path, getAtPath(entry.defaults, path)!)
    }

    const problems = this.ownProblems(entry, value)
    if (problems.length > 0) {
      log?.warn(`${where} fail their validation (${problems.join(' ')}); the defaults are used until the settings are changed`)
      return
    }
    entry.value = deepFreeze(value)
  }

  /** What the owner's `validate` says, with a throwing `validate` reported rather than thrown. */
  private ownProblems(entry: Entry, value: JsonObject): string[] {
    if (!entry.validate) return []
    try {
      const problems = entry.validate(deepFreeze(clone(value)))
      if (problems === undefined || problems === null) return []
      if (!Array.isArray(problems)) return [`Settings "${entry.id}" could not be checked: validate must return a list of messages.`]
      return problems.map(String)
    } catch (err) {
      return [`Settings "${entry.id}" could not be checked: ${describe(err)}`]
    }
  }

  /** Every reason a new value can't be used: its shape, its pages' fields, then the owner's own rules. */
  private problemsOf(entry: Entry, value: JsonObject, pages: readonly SettingsPageDescriptor[]): string[] {
    const shape = shapeProblems(entry.defaults, value).map(({ problem }) => `${problem[0].toUpperCase()}${problem.slice(1)}.`)
    if (shape.length > 0) return shape
    const fields = pages.filter(page => page.settings === entry.id).flatMap(page => page.fields ?? [])
    return [...new Set([...fieldsProblems(fields, value), ...this.ownProblems(entry, value)])]
  }

  private apply(entry: Entry, value: JsonObject) {
    const previous = entry.value
    entry.value = deepFreeze(value)

    const overrides = diffFromDefaults(entry.defaults, value)
    const document: StoredSettings | undefined = Object.keys(overrides).length > 0 ? { version: entry.version, values: overrides } : undefined
    if (document) this.stored.set(entry.id, document)
    else this.stored.delete(entry.id)
    this.schedule(entry.id, document)

    if (!deepEqual(previous, value)) this.fire(entry, previous)
  }

  private fire(entry: Entry, previous: JsonObject) {
    const event: SettingsChangeEvent = { id: entry.id, value: entry.value, previous, changed: changedPaths(previous, entry.value) }
    for (const listener of [...entry.listeners, ...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        this.options.log?.error(`[settings] A listener for settings "${entry.id}" failed`, err)
      }
    }
  }

  private snapshotOf(entry: Entry): SettingsNamespaceSnapshot {
    return {
      id: entry.id,
      owner: entry.owner,
      value: clone(entry.value),
      defaults: clone(entry.defaults),
      ...(entry.readOnly !== undefined && { readOnly: entry.readOnly })
    }
  }

  /** Writes happen one at a time; a namespace changed again before its write starts is written once, as it is then. */
  private schedule(id: string, document: StoredSettings | undefined) {
    if (!this.options.persistence) return
    this.pendingWrites.set(id, document)
    this.draining ??= this.drain()
  }

  private async drain() {
    const persistence = this.options.persistence!
    while (this.pendingWrites.size > 0) {
      const [id, document] = this.pendingWrites.entries().next().value!
      this.pendingWrites.delete(id)
      try {
        await persistence.save(id, document)
        this.failures.delete(id)
      } catch (err) {
        this.failures.set(id, describe(err))
        this.options.log?.error(`[settings] Could not save settings "${id}": ${describe(err)}`)
      }
    }
    this.draining = undefined
  }
}
