# Design note: vault, storage and file handling

| | |
|---|---|
| **Status** | Proposed, not implemented |
| **Date** | 2026-10-16 |
| **Scope** | How Finance data is stored, how files are opened, saved and imported, and how domain plugins (starting with accounts) plug into storage |

## Summary

- **No general "file manager" plugin.** File handling is split by what
  varies:
  - vault persistence → pluggable **storage backends**;
  - file formats (QIF, OFX, CSV…) → **importer and exporter plugins**;
  - user-facing file plumbing (dialogs, recent files, atomic writes, locks)
    → a **shell service**.
- **The vault owns the open-vault session, not the storage format and not
  the domain.** It knows nothing about accounts or transactions; domain
  plugins contribute their schema to it.
- **One pattern throughout:** a plugin *describes* what it offers through
  an extension point (plain data) and *implements* it as a service under
  its own id (behaviour). The consumer discovers descriptors and then calls
  the named service.

## Context

Tessera replaces Microsoft Money Plus. Users keep their finances in a file
(a *vault*), open and close it, and import statements from banks in several
formats. Two requirements shape the design:

1. **Pluggable storage.** A vault might be a SQLite database, an encrypted
   single file, or later something synced. More than one backend can be
   installed at once.
2. **Extensible domain.** Accounts come first. Budgets, investments and
   reports follow, each as a plugin that needs to store its own data.

The framework already provides what this needs (see
[plugin-creation.md](plugin-creation.md)):

- extension points, for many contributors with one consumer;
- services, with exactly one provider per id and activation ordered by
  `services.requires`;
- commands with context-key enablement;
- IPC between a plugin's view and its privileged code.

## Rules this design follows

1. **The vault knows nothing about the domain.** It never mentions accounts,
   transactions or categories.
2. **The shell knows nothing about vaults.** Shell services are generic: a
   file dialog, not "open vault".
3. **Every axis of variation is a plugin seam.** A new storage backend, file
   format or domain area means a new plugin, with no edits to existing ones.
4. **Descriptor + service.** Wherever there can be several implementations
   of the same role, each registers a **descriptor** with an extension point
   and **provides a service under its own id**. This works within the
   one-provider-per-service-id rule, and keeps contributions as plain data.

## Components

```
  storage plugins                      importer plugins
  ───────────────                      ────────────────
  sqlite-storage                       ofx-import, qif-import, csv-import
    contributes → vault.backends         contribute → accounts.importers
    provides      sqlite-storage.backend provide      <plugin>.parser
  encrypted-storage
    contributes → vault.backends
    provides      encrypted-storage.backend
          │                                      │
          │ discovered + called at open time     │ discovered + called at import time
          ▼                                      ▼
  ┌───────────────────────────┐   requires   ┌───────────────────────────┐
  │ vault                     │◄─────────────│ accounts                  │
  │  provides vault.session   │              │  provides accounts.service│
  │  owns     vault.backends  │◄── schema ───│  owns  accounts.importers │
  │           vault.schema    │ contribution │                           │
  └─────────────┬─────────────┘              └─────────────▲─────────────┘
                │ requires                                 │ requires
                ▼                                          │
  ┌───────────────────────────┐              ┌─────────────┴─────────────┐
  │ shell                     │              │ reports, budgets, …       │
  │  provides shell.files     │              └───────────────────────────┘
  └───────────────────────────┘
```

| Component | Kind | Responsibility | Provides | Requires | Extension points it owns |
|---|---|---|---|---|---|
| **shell** | built in | Generic file plumbing: dialogs, recent files, atomic writes, locks | `shell.files` | | |
| **vault** | plugin | The open-vault session: new, open, save, close, backup; schema migrations; vault state as context keys | `vault.session` | `shell.files` | `vault.backends`, `vault.schema` |
| **sqlite-storage**, **encrypted-storage** | plugins | Read and write one storage format | `<plugin>.backend` | (`shell.files` for atomic writes) | |
| **accounts** | plugin | Accounts and transactions: their schema, rules, views and import pipeline | `accounts.service` | `vault.session` | `accounts.importers`, later `accounts.exporters` |
| **ofx-import**, **qif-import**, **csv-import** | plugins | Parse one statement format into a neutral model | `<plugin>.parser` | | |
| **reports**, **budgets**, … | plugins | Further domain areas | (own services) | `vault.session` and/or `accounts.service` | (own) |

### Why importers belong to accounts, not the vault

An imported statement is account data: payees, amounts, dates, matching
against existing transactions. Importing is therefore part of the
**accounts** domain, and the vault stays domain-free (rule 1). Each format
plugin only turns bytes into a neutral `ImportedStatement`; accounts
decides what to do with it.

## Contracts (sketches)

These are TypeScript **sketches**, to be refined when implemented. Plugins
written in JavaScript follow the same shapes.

### `shell.files` (shell service)

```ts
interface ShellFiles {
  showOpenDialog(options: { title?: string, filters?: FileFilter[], defaultPath?: string }): Promise<string | undefined>
  showSaveDialog(options: { title?: string, filters?: FileFilter[], defaultPath?: string }): Promise<string | undefined>

  /** Writes to a temporary file in the same folder, then renames over the target. */
  writeFileAtomic(path: string, data: Uint8Array | string): Promise<void>
  /** Copies a file to a timestamped backup beside it (or in a configured folder); returns the backup path. */
  backup(path: string): Promise<string>

  /** Exclusive lock (a lock file plus a process check), so two windows or instances can't open the same file. */
  lock(path: string): Promise<Disposable>

  readonly recent: {
    list(kind: string): string[]          // kind namespaces lists, e.g. 'vault'
    add(kind: string, path: string): void
  }
}

interface FileFilter { name: string, extensions: string[] }
```

This contains nothing vault-specific, so other plugins (export to PDF, attach
receipts) can use the same service.

### `vault.backends` (extension point) and `<plugin>.backend` (service)

The descriptor, contributed as data:

```ts
interface StorageBackendDescriptor {
  id: string                 // 'sqlite-storage.backend'
  label: string              // 'Tessera vault (SQLite)'
  extensions: string[]       // ['.tvault']
  service: string            // service id implementing StorageBackend
  capabilities: { writeThrough: boolean, encrypted: boolean }
}
```

The behaviour, provided as a service:

```ts
interface StorageBackend {
  /** Cheap check that a file is in this backend's format (magic bytes, header). */
  sniff(path: string): Promise<boolean>
  create(path: string, options: { password?: string }): Promise<StorageHandle>
  open(path: string, options: { password?: string }): Promise<StorageHandle>
}

interface StorageHandle {
  readonly store: Store            // the backend-neutral data API (see open questions)
  flush(): Promise<void>           // no-op for write-through backends
  close(): Promise<void>
}
```

### `vault.schema` (extension point)

Domain plugins declare what they store and how to migrate it:

```ts
interface SchemaDescriptor {
  id: string                 // 'accounts.schema'
  version: number            // current schema version of this contributor
  collections: string[]      // ['accounts.accounts', 'accounts.transactions']
  migrator: string           // service id implementing Migrator
}

interface Migrator {
  /** Upgrades this contributor's data from `from` to `from + 1`. */
  migrate(store: Store, from: number): Promise<void>
}
```

The vault records each contributor's version inside the file. On open, it
runs pending migrations in version order, after taking a backup. A
contributor's collection names are prefixed with its plugin id, so two
domains can't collide.

### `vault.session` (vault service)

A single open vault at a time, as in Money:

```ts
interface VaultSession {
  readonly current: { path: string, backend: string } | undefined
  readonly store: Store                   // throws when no vault is open
  create(path?: string): Promise<void>    // prompts via shell.files when path is omitted
  open(path?: string): Promise<void>
  save(): Promise<void>
  close(): Promise<void>
  markDirty(): void                       // domain plugins call this after changes on buffered backends
  onDidChange(listener: (event: 'opened' | 'closed' | 'saved' | 'dirty') => void): Disposable
}
```

### `accounts.importers` (extension point) and `<plugin>.parser` (service)

```ts
interface ImporterDescriptor {
  id: string                 // 'ofx-import.ofx'
  label: string              // 'OFX / QFX statement'
  extensions: string[]       // ['.ofx', '.qfx']
  service: string            // 'ofx-import.parser'
}

interface StatementParser {
  parse(data: Uint8Array, fileName: string): Promise<ImportedStatement>
}

/** Neutral model; accounts owns matching and applying it. */
interface ImportedStatement {
  account: { number?: string, name?: string, currency: string }
  transactions: { date: string, amount: number, payee?: string, memo?: string, externalId?: string }[]
  balance?: { amount: number, asOf: string }
}
```

### Commands and context keys

| Command | Owner | Enablement | Menu |
|---|---|---|---|
| `vault.new` | vault | none | File › New Vault… |
| `vault.open` | vault | none | File › Open Vault… |
| `vault.save` | vault | `vault.isOpen && vault.isDirty` | File › Save |
| `vault.close` | vault | `vault.isOpen` | File › Close Vault |
| `vault.backup` | vault | `vault.isOpen` | File › Back Up… |
| `accounts.import` | accounts | `vault.isOpen` | File › Import… |

| Context key | Set by | Meaning |
|---|---|---|
| `vault.isOpen` | vault | A vault is open |
| `vault.isDirty` | vault | Unsaved changes; always false on write-through backends |
| `vault.isReadOnly` | vault | Opened read-only, e.g. the lock is held elsewhere and the user chose read-only |

The vault's commands go in a `vault.file` group in the File menu, above the
shell's Exit group.

## Key flows

### Startup

1. Plugins activate in dependency order: shell services first, then
   `vault` (requires `shell.files`), then `accounts` (requires
   `vault.session`), then plugins that require `accounts.service`. Storage
   and importer plugins have no ordering constraint.
2. Vault and accounts register their commands, menus and schema
   contributions; storage and import plugins register descriptors and
   services.
3. **After all plugins have activated**, the vault may reopen the last
   vault from `shell.files.recent`. It must wait until then, because the
   backend it needs may not have activated yet. *(Needs a framework
   "startup complete" event; see Framework prerequisites.)*

### Open a vault

1. The user picks **File › Open Vault…**, which runs `vault.open`.
2. The vault builds dialog filters from the `vault.backends` descriptors,
   then calls `shell.files.showOpenDialog`.
3. It chooses a backend by file extension, falling back to each backend's
   `sniff`.
4. It calls `shell.files.lock(path)`. If the lock fails, it offers read-only
   or cancel.
5. `backend.open(path)` returns a `StorageHandle`. Password prompting for
   encrypted backends is an open question.
6. Schema migrations: compare each `vault.schema` contributor's version
   with the version stored in the file. If any are behind, call
   `shell.files.backup(path)` first, then run each migrator in order.
7. Set `vault.isOpen`, clear `vault.isDirty`, add the file to
   `recent('vault')`, and fire `onDidChange('opened')`. Menus update
   automatically through enablement.

### Edit and save

- **Write-through backends** (SQLite): each change is committed
  immediately; `vault.isDirty` stays false, so Save stays disabled.
- **Buffered backends** (encrypted single file): domain plugins call
  `session.markDirty()`, which enables Save. `vault.save` calls `flush()`,
  which writes through `shell.files.writeFileAtomic`.

### Import a statement

1. **File › Import…** runs `accounts.import`, which is enabled only while a
   vault is open.
2. Accounts builds dialog filters from the `accounts.importers`
   descriptors, shows the dialog, reads the file, and picks the importer by
   extension.
3. `services.get(descriptor.service).parse(data, name)` returns an
   `ImportedStatement`.
4. Accounts matches it against existing accounts and transactions and
   shows a review view (a `shell.views` contribution). On confirmation it
   applies the changes through `vault.session.store`.

### Close and quit

`vault.close` flushes if the vault is dirty (asking first, as Money does),
calls `handle.close()`, releases the lock, and clears the context keys. On
quit the same happens through the vault's `deactivate`. *(Needs the
framework to deactivate plugins on quit; see below.)*

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A general `file-manager` plugin wrapping `fs`** | Privileged plugins already have Node; a wrapper adds a layer without a policy. The parts that do need one owner (dialogs, atomic writes, locks, recent files) are generic, so they belong in a shell service. |
| **File I/O embedded in the vault** | Ties the vault to one storage format, contrary to the pluggable-storage requirement. |
| **A single `vault.storage` service** | The framework allows one provider per service id, so only one backend could be installed. Descriptor + per-plugin service supports many. |
| **Importers as a vault extension point** | Importing is account-domain logic (matching, payees, balances); putting it in the vault breaks rule 1. |
| **Executable functions inside contributions** | Contributions stay plain data, consistent with menus and views, and validatable before any plugin code runs. Behaviour lives in services. |

## Framework prerequisites

The design depends on these, most of which are already in
[todo.md](todo.md):

1. **`shell.files` service**: new shell code. The todo list currently names
   it under "Shell services".
2. **A "startup complete" lifecycle event**, so the vault can reopen the
   last file after every plugin has activated. *(Done: `onStarted`.)*
3. **Deactivate plugins on quit**, so the vault can flush and release its
   lock. *(Done: `onShuttingDown` with veto, then deactivation.)*
4. **Declared extension points**, so the vault and accounts can declare
   `vault.backends`, `vault.schema` and `accounts.importers` and have
   contributions validated against them.
5. **Context keys in the renderer**, so views can grey out buttons on the
   same `vault.*` keys as menus.
6. **Service versioning**, since `vault.session` and `Store` will evolve
   and many plugins will depend on them.

## Open questions

1. **What does `Store` look like?** It must work over both SQLite and an
   encrypted single file. Candidates:
   - a collection/document API (`get`, `put`, `query`, with indexes declared
     in the schema descriptor);
   - a relational API that the file backend emulates.

   The document API is simpler to implement across backends. The
   relational one suits reporting queries. *Leaning: document API with
   declared indexes, plus a query service later if reports need it.*
   **Settled in [storage-api-design.md](storage-api-design.md):** a document
   API with declared indexes, transactions and change events. That note also
   refines `SchemaDescriptor.collections` (it now carries index
   declarations) and answers question 7 (transactions are first-class).
2. **Save model.** Is write-through (Money-like, always saved) the default,
   with the dirty/save flow only for buffered backends? Or should every
   backend buffer, so the user can discard changes?
3. **Passwords and keys** for encrypted vaults: a shell prompt service, OS
   keychain storage, or both? Prompting must not happen in plugin code that
   talks to Electron directly.
4. **First backend.** SQLite in Electron needs a native module (e.g.
   `better-sqlite3`) rebuilt for Electron's ABI, which affects build and
   packaging. Should development start with a simpler pure-JS backend (for
   example, encrypted JSON) to prove the contracts first?
5. **One vault or several?** This design assumes one open vault, as in
   Money. Supporting several would make `vault.session` a factory, and
   context keys would need to name the active vault.
6. **Importing `.mny` files.** Money's format is a proprietary, encrypted
   database. Is migrating from Money a goal for the first release, and if
   so, through an external converter or a native reader?
7. **Transactions and atomicity.** Should `Store` offer multi-write
   transactions (needed for import and transfers), and how do buffered
   backends honour them?

## Suggested phases

1. **Framework:**
   - the `shell.files` service;
   - the startup-complete event;
   - deactivate on quit;
   - declared extension points.
2. **Vault + one backend:**
   - `vault.session`, the `vault.backends` and `vault.schema` points,
     commands, menus and context keys;
   - one backend, chosen per open question 4;
   - a fake backend for tests.
3. **Accounts:** schema contribution and migrator, `accounts.service`,
   account register views.
4. **Import:** the `accounts.importers` point and review view, then OFX, QIF
   and CSV parser plugins.
5. **Second backend**, proving the storage seam with no changes to the vault
   or accounts.
