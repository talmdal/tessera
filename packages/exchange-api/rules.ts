// What makes a payee rule usable. Here, in the shared contract, so the Payee Rules dialog and the service run
// the very same check: when only the service checked, a bad pattern was found after the dialog had closed, the
// save failed, and every other edit made in the dialog was lost with it.
import type { NewPayeeRule, PayeeRule, PayeeRuleMatchKind } from './model'

export const PAYEE_RULE_KINDS: readonly PayeeRuleMatchKind[] = ['contains', 'startsWith', 'equals', 'regex']

export interface PayeeRuleProblem {
  field: 'match' | 'payee'
  message: string
}

/** Why a rule cannot be saved, or undefined when it can. */
export function payeeRuleProblem(rule: NewPayeeRule | PayeeRule): PayeeRuleProblem | undefined {
  if (typeof rule !== 'object' || rule === null) return { field: 'payee', message: 'Enter the rule.' }
  const value = typeof rule.match?.value === 'string' ? rule.match.value.trim() : ''
  if (value === '') return { field: 'match', message: 'Enter what the rule looks for.' }
  const payee = typeof rule.payee === 'string' ? rule.payee.trim() : ''
  if (payee === '') return { field: 'payee', message: 'Enter the payee to use.' }
  if (!PAYEE_RULE_KINDS.includes(rule.match.kind)) return { field: 'match', message: 'Choose how the rule matches.' }
  if (rule.match.kind === 'regex') {
    try { new RegExp(value) } catch { return { field: 'match', message: 'That is not a valid pattern.' } }
  }
  return undefined
}
