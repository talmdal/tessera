// @tessera/reports-api: the published contract of the `reports` plugin, the report manager: the `reports.service`
// service, the three extension points (sources, definitions, groups) and what is contributed to them, the results a
// run produces, and the pure code every party shares: validation, periods and the engine. It depends on
// @tessera/types, @tessera/ledger-api and @tessera/accounts-api, so any plugin can import it.
// See docs/reporting-design.md.
export * from './engine'
export * from './errors'
export * from './labels'
export * from './periods'
export * from './protocol'
export * from './result'
export * from './service'
export * from './settings'
export * from './source'
export * from './spec'
export * from './validate'
export * from './views'

/** Version of this contract. */
export const REPORTS_API_VERSION = '1.4.0'
