// The reports of reports.ts, and a fake bridge answering the reports' channels with them, recording what the view
// asks; and drawing in the shell's theme.
import { render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import type { ReactNode } from 'react'
import { REPORTS_CHANNELS } from '@tessera/reports-api'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../../../shared/fonts/resolveFonts'
import { DEFAULT_THEME } from '../../../../shared/theme/types'
import { createShellTheme } from '../../../../shell/renderer/theme/createShellTheme'
import { createFakeRemote } from '../../../helpers/fakeBridge'
import { catalogOf, incomeResult, openedOf, spendingResult } from './reports'

export const EXECUTE = 'shell:commands.execute'

export * from './reports'

/** A fake bridge answering the reports' channels; `answers` adds or replaces any. Commands run are recorded. */
export function reportsBridge(answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  const all: Record<string, (data: any) => unknown> = {
    [REPORTS_CHANNELS.catalog]: () => catalogOf(),
    [REPORTS_CHANNELS.open]: (data: { ref: { definitionId: string } }) => ({ ok: true, value: openedOf(data.ref.definitionId.replace('reports.', '')) }),
    [REPORTS_CHANNELS.run]: (data: { ref: { definitionId: string } }) => ({ ok: true, value: data.ref.definitionId === 'reports.spendingByCategory' ? spendingResult() : incomeResult() }),
    [REPORTS_CHANNELS.select]: () => undefined,
    [REPORTS_CHANNELS.members]: () => ({ ok: true, value: [] }),
    [EXECUTE]: () => undefined,
    ...answers
  }
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = all[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1]) as any[]
  return { ...remote, calls, executed: () => calls(EXECUTE) as { id: string, args: unknown[] }[] }
}

/** Draws `node` in the shell's theme, light or dark, as the app does. */
export const renderInTheme = (node: ReactNode, mode: 'light' | 'dark' = 'light') => {
  const theme = createShellTheme(DEFAULT_THEME, mode, { fonts: resolveFonts(DEFAULT_FONT_SETTINGS) })
  return { theme, ...render(<ThemeProvider theme={theme}>{node}</ThemeProvider>) }
}
