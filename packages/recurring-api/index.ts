// @tessera/recurring-api: the published contract of the `recurring` plugin: the `recurring.service` service, the
// domain model, the schedule engine, and every id, channel and event the plugin uses. It depends on
// @tessera/types, @tessera/book-api and @tessera/accounts-api, so any plugin can import it.
// See docs/recurring-transactions-design.md.
//
// The schedule engine is here rather than in the plugin because the renderer needs it too: the series dialog
// previews the next few dates as the user types, without a round trip to the main process.
export * from './errors'
export * from './model'
export * from './protocol'
export * from './schedule'
export * from './scheduleEngine'
export * from './service'

/** Version of this contract. */
export const RECURRING_API_VERSION = '1.0.0'
