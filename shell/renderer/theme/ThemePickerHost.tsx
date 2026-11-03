// shell/renderer/theme/ThemePickerHost.tsx — opens the chooser when the main process asks this window to.
import { useEffect, useState } from 'react'
import { useLayout } from '../state/ShellState'
import { useShellTheme } from './ShellThemeProvider'
import { ThemePicker } from './ThemePicker'

/**
 * Mounted once in the window. The `shell.theme.choose` command publishes
 * `shell:theme.picker.open` naming the focused window; this window opens the
 * chooser when that is its own id (as `shell:layout.revealed` is handled) and
 * ignores requests meant for other windows.
 */
export function ThemePickerHost() {
  const { windowId } = useLayout()
  const { onChooserRequested } = useShellTheme()
  const [open, setOpen] = useState(false)

  useEffect(() => onChooserRequested(requested => {
    if (requested === windowId) setOpen(true)
  }), [onChooserRequested, windowId])

  return <ThemePicker open={open} onClose={() => setOpen(false)} />
}
