// plugins/theme.sample/src/renderer/Swatches.tsx
//
// The sample's main-area page: the active theme, the themes on offer, and a
// swatch for every resolved token. It shows both ways a view can use the
// theme. The swatches are painted with `var(--token)`, which is all most
// views ever need: the shell keeps the variables up to date and the browser
// repaints. The names and hex values come from the theme snapshot and its
// change event over `window.api`, the route for code that needs a value.
import type { ThemeState } from '@tessera/types'
import { useEffect, useState } from 'react'
import { HIGHLIGHT_TOKEN } from '../shared'

const THEME_GET = 'shell:theme.get'
const THEME_CHANGED = 'shell:theme.changed'

/** The CSS variable a token is published as: dots become dashes (see shared/theme/types.ts). */
const variable = (token: string) => `--${token.replace(/\./g, '-')}`

export default function Swatches() {
  const theme = useThemeState()
  if (!theme) return <p>Loading the theme…</p>

  const groups = groupByOwner(Object.keys(theme.colors))

  return (
    <div data-theme-sample="swatches">
      <h1>Theme swatches</h1>
      <p>
        The active theme is <strong data-theme-sample-active>{theme.activeTheme}</strong> ({theme.kind}).
        Every colour below is a token the shell or a plugin contributed, resolved by the shell and
        published as a CSS variable; the swatches read the variable, the values come from the snapshot.
      </p>
      <p>
        <button type="button" onClick={() => run('shell.theme.toggleDark')}>Toggle light/dark</button>{' '}
        <button type="button" onClick={() => run('shell.theme.choose')}>Choose theme…</button>
      </p>

      <h2>Themes</h2>
      <ul style={{ padding: 0, listStyle: 'none' }}>
        {theme.themes.map(t => (
          <li key={t.id} data-theme-sample-theme={t.id}
              style={{ padding: '4px 8px', background: t.id === theme.activeTheme ? `var(${variable(HIGHLIGHT_TOKEN)})` : undefined }}>
            <strong>{t.label}</strong> <code>{t.id}</code> · {t.kind} · from <code>{t.pluginId}</code>
          </li>
        ))}
      </ul>

      {groups.map(([owner, tokens]) => (
        <section key={owner}>
          <h2><code>{owner}</code></h2>
          <table style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {tokens.map(token => (
                <tr key={token} data-theme-sample-token={token}>
                  <td style={cell}>
                    <span aria-hidden="true" style={{ ...swatch, background: `var(${variable(token)})` }} />
                  </td>
                  <td style={cell}><code>{token}</code></td>
                  <td style={{ ...cell, fontFamily: 'var(--shell-font-monoFamily)' }}>{theme.colors[token]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}

/** Runs one of the shell's theme commands, as a menu item would. */
function run(command: string) {
  window.api.invoke('shell:commands.execute', { id: command })
    .catch(err => console.error(`[theme-sample] ${command} failed`, err))
}

/** Token ids grouped by the plugin that owns them (the first dotted segment), shell first. */
function groupByOwner(tokens: string[]): [string, string[]][] {
  const groups = new Map<string, string[]>()
  for (const token of tokens) {
    const owner = token.slice(0, token.indexOf('.'))
    if (!groups.has(owner)) groups.set(owner, [])
    groups.get(owner)!.push(token)
  }
  return [...groups.entries()].sort(([a], [b]) => (a === 'shell' ? -1 : b === 'shell' ? 1 : a.localeCompare(b)))
}

/**
 * The shell's theme, as seen from a plugin view: subscribe to the change
 * event first, then request the snapshot, so nothing is missed in between.
 */
function useThemeState(): ThemeState | undefined {
  const [state, setState] = useState<ThemeState>()

  useEffect(() => {
    const stop = window.api.on<ThemeState>(THEME_CHANGED, setState)
    window.api.invoke<ThemeState>(THEME_GET).then(
      current => setState(previous => previous ?? current),
      err => console.error('[theme-sample] Could not load the theme', err)
    )
    return stop
  }, [])

  return state
}

const cell = { border: '1px solid var(--shell-border)', padding: '4px 12px', textAlign: 'left' as const }
const swatch = { display: 'inline-block', width: 28, height: 16, border: '1px solid var(--shell-border)', verticalAlign: 'middle' }
