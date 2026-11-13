// @tessera/export-api: the published contract of the `export` plugin (the export manager). It holds:
// - the `export.formats` extension point and the `ExportFormat` service file-type plugins provide;
// - the neutral, already-resolved data those services write;
// - every id, command, channel and dialog the plugin uses, with their payloads;
// - pure helpers for format authors: exact amounts, text encodings, file names, options.
// Types, constants and pure functions only. It depends on @tessera/types, @tessera/ledger-api and
// @tessera/accounts-api, so any plugin can import it. See docs/export-design.md.
export * from './contract'
export * from './errors'
export * from './helpers'
export * from './protocol'

/** Version of this contract. */
export const EXPORT_API_VERSION = '1.3.0'
