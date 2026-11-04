// @tessera/book-api: the published contract of the `book` plugin: the `book.session` service, the
// `book.schema` extension point, and every id, channel and event the plugin uses. Types and constants only
// (plus the tiny `ok`/`fail` result helpers); it depends on @tessera/types alone, so any plugin can import it.
// See docs/account-manager-design.md.
export * from './errors'
export * from './model'
export * from './names'
export * from './protocol'
export * from './service'

/** Version of this contract. */
export const BOOK_API_VERSION = '1.0.0'
