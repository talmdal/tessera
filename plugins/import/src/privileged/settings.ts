// The import's settings: how closely a bank line must match a transaction the user entered. The tolerances are tuned
// together, so the user chooses a preset, never a number (see matching/tuning.ts). Kept by the shell's settings
// framework (namespace `import`) and edited on a page the shell draws.
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsDefinition, SettingsPageContribution } from '@tessera/types'
import { IMPORT_SETTINGS_PAGE } from '@tessera/import-api'
import { MATCHING_PRESETS, MATCHING_PRESET_IDS, isMatchingPreset, type MatchTuning, type MatchingPreset } from './matching/tuning'

export type ImportSettings = {
  /** Which set of matching tolerances to use. */
  matching: MatchingPreset
}

export const IMPORT_SETTINGS: SettingsDefinition<ImportSettings> = {
  defaults: { matching: 'balanced' },
  validate: ({ matching }) => isMatchingPreset(matching) ? [] : [`Choose one of ${MATCHING_PRESET_IDS.join(', ')}.`]
}

/** The tolerances a setting chooses. */
export const tuningOf = (settings: ImportSettings): MatchTuning => MATCHING_PRESETS[settings.matching]

export const SETTINGS_PAGE: SettingsPageContribution = {
  id: IMPORT_SETTINGS_PAGE,
  title: 'Import',
  description: 'How closely a line of a bank statement must match a transaction you entered before it is proposed as a match.',
  keywords: ['matching', 'match', 'tolerance', 'fuzzy', 'statement', 'bank', 'ofx', 'tip', 'posting'],
  fields: [{
    kind: 'choice',
    key: 'matching',
    label: 'Matching',
    description: 'Whatever is proposed is yours to accept or change in the register. Applies to the next import, and to proposals still to review.',
    options: [
      {
        value: 'strict', label: 'Strict',
        description: 'Fewer, surer matches. The bank posts within a week, and amounts differ by little more than rounding. More lines are added as new.'
      },
      {
        value: 'balanced', label: 'Balanced (recommended)',
        description: 'The bank posts within two weeks; amounts may differ by a tip or a fuel estimate.'
      },
      {
        value: 'lenient', label: 'Lenient',
        description: 'For banks that post late, and large tips or estimates: three weeks, and bigger differences. More matches to check.'
      }
    ]
  }]
}

export const settingsContribution = (): [string, string, unknown] => [SETTINGS_PAGES_EXTENSION_POINT, SETTINGS_PAGE.id, SETTINGS_PAGE]
