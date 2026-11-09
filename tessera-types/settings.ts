// Settings (user preferences): what a plugin's settings are, how it reads and changes them, and how it contributes
// the pages the user edits them on. The framework owns storage, the Options dialog and the edit lifecycle (draft,
// validate, apply, cancel, restore defaults); plugins own the shape of their settings and, optionally, the page UI.
// See docs/settings-design.md.
import type { Disposable, Event, JsonObject } from '.'

/** Extension point for `SettingsPageContribution`s: the pages of the Options dialog. */
export const SETTINGS_PAGES_EXTENSION_POINT = 'shell.settings.pages'

/**
 * The folder in the user-data folder where the shell keeps settings, one `<namespace>.json` each (only what differs
 * from the defaults; a file that wasn't valid JSON is set aside as `<namespace>.json.bad`).
 */
export const SETTINGS_FOLDER = 'settings'

/** Opens the Options dialog in the focused window. Optional argument: the id of the page to show. */
export const SETTINGS_OPEN_COMMAND = 'shell.settings.open'

/**
 * A settings namespace id: the owner's plugin id, or `<pluginId>.<name>` with lower-case dotted names. It names the
 * file the values are kept in, so it is restricted to characters that are safe in a file name on every platform.
 */
export const SETTINGS_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z0-9][a-z0-9-]*)*$/

// ---- Registering and reading (privileged side) ---------------------------------------------------------------------

/**
 * What a plugin registers: the defaults give the shape. Values are JSON, and the top level is an object. Use a type
 * alias or an interface; either works as `T`.
 */
export interface SettingsDefinition<T extends object = JsonObject> {
  /** The namespace. Default: the plugin id. A plugin may register several, each `<pluginId>.<name>`. */
  id?: string
  /** Every setting and its default. A stored value is merged over these, so a key added later needs no migration. */
  defaults: T
  /** The shape's version, a whole number from 1 (the default). Raise it when a stored value needs `migrate`. */
  version?: number
  /**
   * Upgrades values saved by an older version of the plugin (`fromVersion` is theirs). Receives the stored
   * overrides, not the merged value, and returns what to merge over the defaults.
   */
  migrate?(stored: JsonObject, fromVersion: number): object
  /**
   * The authoritative check, run on every change and on what is loaded. Returns messages for the user, or nothing
   * when the value is fine. The defaults must pass it.
   */
  validate?(value: T): readonly string[] | undefined | void
}

/** What a namespace's listeners hear after each change: from the Options dialog's OK or Apply, or from its owner. */
export interface SettingsChangeEvent<T = JsonObject> {
  id: string
  value: T
  previous: T
  /**
   * The settings that changed, so a listener can act on just those: top-level keys (`recentLimit`), or dotted paths
   * for keys in nested objects (`matching.days`). A list counts as one setting. Never empty.
   */
  changed: string[]
}

/**
 * A namespace to read, with no way to change it: how a plugin reads another plugin's settings. Changes are made by the
 * user in the Options dialog, or by the owner, and always through the settings manager, with the owner's checks.
 */
export interface SettingsReader<T extends object = JsonObject> {
  readonly id: string
  /**
   * The current value, frozen; undefined while nobody has registered the namespace (its owner hasn't activated yet, or
   * isn't installed). Read it once every plugin has activated (`lifecycle.onStarted`), or require a service the owner
   * provides, so the owner activates first.
   */
  get(): T | undefined
  /** After every change to the namespace, whoever made it. Removed when your plugin deactivates. */
  onDidChange(listener: (event: SettingsChangeEvent<T>) => void): Disposable
}

/** A registered namespace, as its owner sees it. Disposed with the plugin. */
export interface SettingsHandle<T extends object = JsonObject> {
  readonly id: string
  /** The defaults, frozen. */
  readonly defaults: T
  /** The current value: the defaults with the user's changes merged over them. Never partial, and frozen. */
  get(): T
  /**
   * Changes some top-level settings, as if the user had (a "don't ask again" box, say). Rejects, changing nothing,
   * with the messages in `problems` when the result fails validation. Resolves once it is written; a failed write is
   * logged and the value stays in effect for the session.
   */
  update(patch: Partial<T>): Promise<void>
  /** Back to the defaults: the user's changes are forgotten. */
  reset(): Promise<void>
  /** After every change, from the Options dialog or from `update` and `reset`. */
  onDidChange(listener: (event: SettingsChangeEvent<T>) => void): Disposable
}

/** `context.settings`: the plugin's own settings, and read-only access to everyone's. */
export interface SettingsApi {
  /** Registers a namespace, reading what was saved for it. Throws for an id the plugin doesn't own, or a bad definition. */
  register<T extends object>(definition: SettingsDefinition<T>): SettingsHandle<T>
  /** Any namespace, the plugin's own or another's, to read. Throws for an id that isn't a settings id. */
  read<T extends object = JsonObject>(id: string): SettingsReader<T>
  /**
   * Every registered namespace as it is now: owner, value, defaults, and why it can't be changed when it can't. Copies,
   * to read (a settings inspector, diagnostics); nothing here changes a setting.
   */
  snapshots(): SettingsNamespaceSnapshot[]
}

// ---- Pages (the Options dialog) ------------------------------------------------------------------------------------

interface SettingsFieldBase {
  /** Where the value is in the namespace: a top-level key, or a dotted path into nested objects (`matching.days`). */
  key: string
  label: string
  /** Help under the field. */
  description?: string
}

/** A checkbox. The default must be a boolean. */
export interface BooleanSettingsField extends SettingsFieldBase {
  kind: 'boolean'
}

/** A number box. The default must be a number. */
export interface NumberSettingsField extends SettingsFieldBase {
  kind: 'number'
  min?: number
  max?: number
  /** Whole numbers only. */
  integer?: boolean
  /** Shown after the box: "days", "%". */
  unit?: string
}

/** A line of text. The default must be a string. */
export interface TextSettingsField extends SettingsFieldBase {
  kind: 'text'
  placeholder?: string
  maxLength?: number
  /** An empty (or all-blank) value is refused. */
  required?: boolean
}

/** One of a few values, as radio buttons. The default must be one of them. */
export interface ChoiceSettingsField extends SettingsFieldBase {
  kind: 'choice'
  /** `description` is a line under the option, saying what choosing it means. */
  options: { value: string | number, label: string, description?: string }[]
}

/**
 * A folder, chosen with the platform's folder dialog (Browse…), or '' for the default (Default). The default must be a
 * string; a value is '' or a full path. Whether the folder is there isn't checked: a drive can be unplugged and
 * plugged back in, so the plugin checks it when it uses it.
 */
export interface FolderSettingsField extends SettingsFieldBase {
  kind: 'folder'
  /** Shown while the value is '': what the default is ("C:\\Users\\me\\Documents\\Tessera Backups"). */
  placeholder?: string
}

/** A field of a page the shell draws. Its constraints are checked in the dialog and again when the value is saved. */
export type SettingsField = BooleanSettingsField | NumberSettingsField | TextSettingsField | ChoiceSettingsField | FolderSettingsField

/**
 * A page of the Options dialog, contributed from a plugin's privileged `activate` as plain data:
 * `context.extensions.contribute(pluginId, SETTINGS_PAGES_EXTENSION_POINT, id, page)`.
 *
 * A page has `fields` (the shell draws a form), or a `module` (the plugin's own component), or neither (a
 * category: a heading that lists the pages under it).
 */
export interface SettingsPageContribution {
  /** `<pluginId>.<name>`. */
  id: string
  title: string
  /** The page (or category) this one is nested under; omitted for the top level. Any plugin's page will do. */
  parent?: string
  /** The namespace the page edits: one the contributing plugin registered. Default: the plugin id. */
  settings?: string
  /** A module the plugin's renderer remote exposes ("./LedgerSettingsPage"). Its default export is the component. */
  module?: string
  fields?: SettingsField[]
  /** A sentence under the title. */
  description?: string
  /** More words the search box should find the page by. Titles, descriptions and field labels are searched already. */
  keywords?: string[]
  /** Among the pages with the same parent; lower first. Ties keep registration order. Default 0. */
  order?: number
}

/** The props of a page component (`module`). Pages never read or save settings themselves: the dialog does. */
export interface SettingsPageProps<T extends object = JsonObject> {
  /** The draft of the namespace: what the user sees, including changes not yet applied. */
  value: T
  defaults: T
  /** Replaces the draft. Pass a new object; the value must be JSON. */
  onChange(next: T): void
  /**
   * Disables OK and Apply while false (a half-typed number, say). For the user's benefit only: the namespace's
   * `validate` in the main process is what decides.
   */
  onValidityChange(valid: boolean): void
  /** True while the dialog is saving, or when the settings can't be changed (saved by a newer version). */
  disabled: boolean
  /** What the main process refused the last time the user applied this namespace. */
  errors: readonly string[]
}

// ---- The registry (process-wide; the shell's view) -----------------------------------------------------------------

/** A valid page, as resolved against the registered namespaces. */
export interface SettingsPageDescriptor {
  id: string
  title: string
  pluginId: string
  parent?: string
  /** Absent for a category. */
  settings?: string
  module?: string
  fields?: SettingsField[]
  description?: string
  keywords: string[]
}

/** A namespace as the Options dialog sees it. */
export interface SettingsNamespaceSnapshot {
  id: string
  /** The plugin (or `shell`) that registered it. */
  owner: string
  value: JsonObject
  defaults: JsonObject
  /** Why the settings can't be changed now, when they can't: they were saved by a newer version of the plugin. */
  readOnly?: string
}

export type SettingsCommitResult =
  | { ok: true, namespaces: SettingsNamespaceSnapshot[], /** Set when the values are in effect but could not be written. */ saveError?: string }
  /** Nothing was changed. The messages, by namespace id. */
  | { ok: false, errors: Record<string, string[]> }

/**
 * Every namespace's settings, behind `PluginContext.settings`. Plugins see their own through `SettingsApi`; the rest
 * is for the shell (the Options dialog and start-up).
 */
export interface SettingsRegistry {
  /** Fires after a namespace's value changes. */
  readonly onDidChange: Event<SettingsChangeEvent>
  /** Reads what was saved. Call once, before plugins activate. */
  load(): Promise<void>
  /** `owner` must own the id (it is the id, or the id starts with `<owner>.`). */
  register<T extends object>(owner: string, definition: SettingsDefinition<T>): SettingsHandle<T> & Disposable
  has(id: string): boolean
  /** Read-only access to a namespace, registered or not (yet). */
  reader<T extends object = JsonObject>(id: string): SettingsReader<T>
  snapshot(id: string): SettingsNamespaceSnapshot | undefined
  snapshots(): SettingsNamespaceSnapshot[]
  /** The valid `shell.settings.pages` contributions, parents before children and in order. Problems are logged. */
  pages(): SettingsPageDescriptor[]
  /** Validates every change, then applies all of them or none. */
  commit(changes: readonly { id: string, value: unknown }[]): Promise<SettingsCommitResult>
  /** Resolves once every pending write has finished. */
  flush(): Promise<void>
}
