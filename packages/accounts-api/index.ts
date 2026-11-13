// @tessera/accounts-api: the published contract of the `accounts` plugin: the `accounts.service` service, the
// domain model, money helpers and account rules, and every id, channel and event the plugin uses. It depends on
// @tessera/types and @tessera/ledger-api, so any plugin can import it. See docs/account-manager-design.md.
export * from './annotations'
export * from './errors'
export * from './model'
export * from './money'
export * from './reconciliation'
export * from './protocol'
export * from './rules'
export * from './service'
export * from './transactions'

/** Version of this contract. */
export const ACCOUNTS_API_VERSION = '1.12.0'
