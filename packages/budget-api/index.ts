// @tessera/budget-api: the published contract of the `budget` plugin: the `budget.service` service, the budget
// model, the planning arithmetic (pure, so the service and the dialogs agree), and every id the plugin uses. It depends
// on @tessera/types, @tessera/ledger-api and @tessera/accounts-api, so any plugin can import it.
// See docs/budget-design.md.
export * from './errors'
export * from './model'
export * from './plan'
export * from './protocol'
export * from './service'

/** Version of this contract. */
export const BUDGET_API_VERSION = '1.4.0'
