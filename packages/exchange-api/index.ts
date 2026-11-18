// @tessera/exchange-api: the published contract of the `exchange` plugin — importing a statement or a data file
// into a book, and writing one back out. It holds the neutral `ExchangeDocument` every format reader produces,
// the `exchange.formats` seam a format plugin attaches to, the `exchange.service` service, and every id, channel
// and event the plugin uses. It depends on @tessera/types, @tessera/book-api and @tessera/accounts-api, so any
// plugin can import it. See docs/import-export-design.md.
export * from './csv'
export * from './errors'
export * from './exportOptions'
export * from './format'
export * from './model'
export * from './options'
export * from './protocol'
export * from './rules'
export * from './service'

/** Version of this contract. */
export const EXCHANGE_API_VERSION = '1.0.0'
