// @tessera/import-api: the published contract of the `import` plugin (the import manager). It holds:
// - the `import.formats` extension point and the `ImportFormat` service format plugins provide;
// - the neutral statement those services produce;
// - the `import.manager` service other plugins use;
// - every id, command, channel, event and dialog the plugin uses;
// - pure helpers for format authors.
// Types, constants and pure functions only. It depends on @tessera/types, @tessera/ledger-api and
// @tessera/accounts-api, so any plugin can import it. See docs/import-manager-design.md.
export * from './contract'
export * from './errors'
export * from './helpers'
export * from './manager'
export * from './model'
export * from './protocol'

/** Version of this contract. */
export const IMPORT_API_VERSION = '1.8.0'
