// shell/renderer/theme/ThemeChooser.tsx
//
// The theme chooser: a modal the shell.theme.choose command opens in the
// focused window (over the shell:theme.chooseRequested event). It edits the
// preference live through shell:theme.set, so every choice previews at once
// in the whole window, the dialog included; Cancel sends back the preference
// the dialog opened with. See docs/style-manager-design.md.
import type { ThemeDescriptor, ThemeKind, ThemePreference, ThemeSetRequest } from '@tessera/types'
import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import { SYSTEM_THEME, THEME_CHOOSE_REQUESTED, THEME_SET, ThemeChooseRequestedEvent } from '../../../shared/theme/types'
import { useLayout, useShellBridge, useTheme } from '../state/ShellState'
import './themeChooser.css'

const KIND_LABEL: Record<ThemeKind, string> = { light: 'Light themes', dark: 'Dark themes' }

export function ThemeChooser() {
  const bridge = useShellBridge()
  const theme = useTheme()
  const { windowId } = useLayout()
  /** The preference the dialog opened with, for Cancel; null while closed. */
  const [original, setOriginal] = useState<ThemePreference | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const ownWindowId = useRef(windowId)
  ownWindowId.current = windowId
  const preference = useRef(theme.preference)
  preference.current = theme.preference

  useEffect(() => bridge.on<ThemeChooseRequestedEvent>(THEME_CHOOSE_REQUESTED, event => {
    if (event?.windowId !== undefined && event.windowId !== ownWindowId.current) return
    opener.current = document.activeElement
    setOriginal(current => current ?? { ...preference.current })
  }), [bridge])

  // Focus the dialog when it opens; give focus back when it closes.
  const open = original !== null
  useEffect(() => {
    if (open) {
      dialog.current?.querySelector<HTMLElement>('input:checked')?.focus()
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus()
      opener.current = null
    }
  }, [open])

  if (!open) return null

  const set = (request: ThemeSetRequest) => {
    bridge.invoke(THEME_SET, request).catch(err => console.error('[theme] Could not change the theme', err))
  }
  const ok = () => setOriginal(null)
  const cancel = () => {
    const { theme, light, dark } = original
    set({ theme, light, dark })
    setOriginal(null)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    } else if (event.key === 'Tab') {
      trapTab(event, dialog.current)
    }
  }

  const { preference: current, themes, kind } = theme
  const byKind = (wanted: ThemeKind) => themes.filter(t => t.kind === wanted)
  const following = current.theme === SYSTEM_THEME

  return (
    <div className="tc-overlay" onMouseDown={event => { if (event.target === event.currentTarget) cancel() }}>
      <div className="tc-dialog" role="dialog" aria-modal="true" aria-labelledby="tc-title" ref={dialog} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id="tc-title">Choose Theme</h2>

        <label className="tc-option">
          <input type="radio" name="tc-theme" value={SYSTEM_THEME} checked={following} onChange={() => set({ theme: SYSTEM_THEME })} />
          <span>Follow the system</span>
          <span className="tc-option-meta">now {kind}</span>
        </label>
        {following && (
          <div className="tc-system">
            <label htmlFor="tc-light">When light:</label>
            <ThemeSelect id="tc-light" themes={byKind('light')} value={current.light} onChange={light => set({ light })} />
            <label htmlFor="tc-dark">When dark:</label>
            <ThemeSelect id="tc-dark" themes={byKind('dark')} value={current.dark} onChange={dark => set({ dark })} />
          </div>
        )}

        {(['light', 'dark'] as const).map(k => byKind(k).length > 0 && (
          <section key={k} aria-label={KIND_LABEL[k]}>
            <h3>{KIND_LABEL[k]}</h3>
            {byKind(k).map(t => (
              <label key={t.id} className="tc-option">
                <input type="radio" name="tc-theme" value={t.id} checked={current.theme === t.id} onChange={() => set({ theme: t.id })} />
                <span>{t.label}</span>
                <span className="tc-option-meta">{t.pluginId === 'shell' ? 'built in' : `from ${t.pluginId}`}</span>
              </label>
            ))}
          </section>
        ))}

        <div className="tc-buttons">
          <button type="button" className="tc-button" onClick={cancel}>Cancel</button>
          <button type="button" className="tc-button tc-button-primary" onClick={ok}>OK</button>
        </div>
      </div>
    </div>
  )
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/** Keeps Tab and Shift+Tab inside the dialog: it is modal, so nothing behind it should take focus. */
function trapTab(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog) return
  // Unchecked radios of a checked group are skipped by the browser's own Tab order.
  const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(el => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && dialog.querySelector(`input[name="${el.name}"]:checked`)))
  if (focusable.length === 0) return
  const first = focusable[0], last = focusable[focusable.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function ThemeSelect({ id, themes, value, onChange }: {
  id: string, themes: ThemeDescriptor[], value: string, onChange: (id: string) => void
}) {
  return (
    <select id={id} className="tc-select" value={value} onChange={event => onChange(event.target.value)}>
      {themes.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
    </select>
  )
}
