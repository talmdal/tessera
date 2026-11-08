import type { SettingsPageProps } from '@tessera/types'
import { FormControlLabel, Checkbox } from '@tessera/ui'

/** A settings page written the way a plugin should: it shows the draft it is given and reports changes. */
export default function ThemedSettingsPage({ value, onChange, disabled }: SettingsPageProps<{ compact: boolean }>) {
  return (
    <FormControlLabel label="Compact rows" disabled={disabled}
      control={<Checkbox checked={value.compact} onChange={event => onChange({ ...value, compact: event.target.checked })} />} />
  )
}
