// shell/renderer/settings/SettingsDialog.tsx — the Options dialog: every plugin's settings pages in one place.
import { Component, ComponentType, ErrorInfo, KeyboardEvent, ReactNode, Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  JsonObject, SettingsCommitResult, SettingsNamespaceSnapshot, SettingsPageProps, TesseraBridge
} from '@tessera/types'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Icon, List, ListItemButton, ListItemText, Stack,
  TextField, Typography
} from '@tessera/ui'
import { searchPages } from '../../../shared/settings/search'
import {
  SETTINGS_CHANGED, SETTINGS_CHOOSE_FOLDER, SETTINGS_COMMIT, SETTINGS_GET, SETTINGS_OPEN, SettingsCatalogue, SettingsChanged,
  SettingsChooseFolder, SettingsCommitRequest, SettingsOpen, SettingsPageInfo
} from '../../../shared/settings/types'
import { clone, deepEqual, getAtPath, isPlainObject, jsonProblem, setAtPath } from '../../../shared/settings/values'
import { Loading } from '../Loading'
import { useWindowTheme } from '../theme/ShellThemeProvider'
import type { ViewLoader } from '../views/ports'
import { BUILT_IN_SETTINGS_PAGES } from './builtIns'
import { FieldsPage } from './FieldsPage'

type Bridge = Pick<TesseraBridge, 'invoke' | 'on'>
export type SettingsPageComponent = ComponentType<SettingsPageProps<any>>

interface Opened {
  catalogue: SettingsCatalogue
  /** The page asked for, and a number that changes with each request, so asking again while open still moves there. */
  page?: string
  request: number
}

/**
 * Opens the Options dialog in this window when the main process says so (`shell.settings.open`, Tools ▸ Options…).
 * The pages and values are fetched as it opens, so they include every plugin's and what changed since.
 * `builtIns` are the components of the shell's own pages, by module.
 */
export function SettingsDialog({ bridge, loader, builtIns = BUILT_IN_SETTINGS_PAGES }: {
  bridge: Bridge
  loader: ViewLoader
  builtIns?: Readonly<Record<string, SettingsPageComponent>>
}) {
  const { windowId } = useWindowTheme()
  const [opened, setOpened] = useState<Opened>()
  const phase = useRef<'closed' | 'loading' | 'open'>('closed')

  useEffect(() => bridge.on<SettingsOpen>(SETTINGS_OPEN, request => {
    if (request.windowId !== windowId) return
    if (phase.current === 'open') {
      // Already open: show the page asked for, keeping the user's unapplied changes.
      setOpened(current => current && { ...current, page: request.page, request: current.request + 1 })
      return
    }
    if (phase.current === 'loading') return
    phase.current = 'loading'
    bridge.invoke<SettingsCatalogue>(SETTINGS_GET).then(
      catalogue => {
        phase.current = 'open'
        setOpened({ catalogue, page: request.page, request: 0 })
      },
      err => {
        phase.current = 'closed'
        console.error('[settings] Could not open the settings', err)
      })
  }), [bridge, windowId])

  const close = useCallback(() => {
    phase.current = 'closed'
    setOpened(undefined)
  }, [])

  if (!opened) return null
  return <SettingsEditor opened={opened} bridge={bridge} loader={loader} builtIns={builtIns} onClose={close} />
}

interface Model {
  /** What is in effect, by namespace. */
  stored: Record<string, SettingsNamespaceSnapshot>
  /** What the pages show, by namespace: the stored value plus the user's unapplied changes. */
  drafts: Record<string, JsonObject>
}

const byId = (namespaces: readonly SettingsNamespaceSnapshot[]) => Object.fromEntries(namespaces.map(n => [n.id, n]))
const dirtyIds = ({ stored, drafts }: Model) => Object.keys(drafts).filter(id => stored[id] && !deepEqual(drafts[id], stored[id].value))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^HANDLER_ERROR: /, '')

function SettingsEditor({ opened, bridge, loader, builtIns, onClose }: {
  opened: Opened
  bridge: Bridge
  loader: ViewLoader
  builtIns: Readonly<Record<string, SettingsPageComponent>>
  onClose(): void
}) {
  const titleId = useId()
  const { pages } = opened.catalogue
  // A `folder` field's Browse…: the platform's folder dialog, in the main process
  const chooseFolder = useCallback((request: SettingsChooseFolder) => bridge.invoke<string | undefined>(SETTINGS_CHOOSE_FOLDER, request), [bridge])
  const [model, setModel] = useState<Model>(() => ({
    stored: byId(opened.catalogue.namespaces),
    drafts: Object.fromEntries(opened.catalogue.namespaces.map(n => [n.id, clone(n.value)]))
  }))
  const [selected, setSelected] = useState(() => pages.find(p => p.id === opened.page)?.id ?? pages[0]?.id)
  // Pages stay mounted once shown, so what a page keeps to itself (half-typed text) survives moving between pages.
  const [visited, setVisited] = useState(() => new Set(selected === undefined ? [] : [selected]))
  const [query, setQuery] = useState('')
  const [invalid, setInvalid] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ severity: 'warning' | 'error', text: string }>()
  const [confirming, setConfirming] = useState(false)

  const select = useCallback((id: string) => {
    setSelected(id)
    setVisited(current => current.has(id) ? current : new Set([...current, id]))
  }, [])

  // Asked for a page while already open (each request has a new number, so asking twice for one page still goes there)
  useEffect(() => {
    if (opened.page !== undefined && pages.some(p => p.id === opened.page)) select(opened.page)
  }, [opened.request, opened.page, pages, select])

  // A change applied elsewhere (another window, or a plugin) becomes what is in effect; a namespace the user hasn't
  // touched shows it, one with unapplied changes keeps them.
  useEffect(() => bridge.on<SettingsChanged>(SETTINGS_CHANGED, ({ changed: _changed, ...snapshot }) => {
    setModel(m => {
      const edited = m.drafts[snapshot.id] !== undefined && m.stored[snapshot.id] !== undefined && !deepEqual(m.drafts[snapshot.id], m.stored[snapshot.id].value)
      return {
        stored: { ...m.stored, [snapshot.id]: snapshot },
        drafts: edited ? m.drafts : { ...m.drafts, [snapshot.id]: clone(snapshot.value) }
      }
    })
  }), [bridge])

  const setDraft = useCallback((id: string, next: unknown) => {
    const problem = isPlainObject(next) ? jsonProblem(next) : 'the new value is not an object'
    if (problem) {
      console.error(`[settings] Ignored a change to settings "${id}": ${problem}`)
      return
    }
    setModel(m => ({ ...m, drafts: { ...m.drafts, [id]: clone(next as JsonObject) } }))
    // What the main process refused is about the old draft
    setErrors(current => {
      if (!current[id]) return current
      const { [id]: _dropped, ...rest } = current
      return rest
    })
  }, [])

  // Stable per page, so a page's effects that depend on them don't run on every render.
  const handlers = useMemo(() => Object.fromEntries(pages.map(page => [page.id, {
    onChange: (next: unknown) => { if (page.settings !== undefined) setDraft(page.settings, next) },
    onValidityChange: (valid: boolean) => setInvalid(current => current[page.id] === !valid ? current : { ...current, [page.id]: !valid })
  }])), [pages, setDraft])

  const dirty = dirtyIds(model)
  const anyInvalid = Object.values(invalid).some(Boolean)
  const page = pages.find(p => p.id === selected)
  // OK and Apply are off while a page is invalid; when it isn't the page shown, say where it is.
  const elsewhere = page !== undefined && invalid[page.id] ? undefined : pages.find(p => invalid[p.id])

  /** Applies every changed namespace, all or none. True when there is nothing left to apply. */
  const apply = async (): Promise<boolean> => {
    if (dirty.length === 0) return true
    setBusy(true)
    setNotice(undefined)
    try {
      const request: SettingsCommitRequest = { changes: dirty.map(id => ({ id, value: model.drafts[id] })) }
      const result = await bridge.invoke<SettingsCommitResult>(SETTINGS_COMMIT, request)
      if (!result.ok) {
        setErrors(result.errors)
        // Show where the first problem is, unless the page shown has one
        if (!(page?.settings !== undefined && result.errors[page.settings])) {
          const first = pages.find(p => p.settings !== undefined && result.errors[p.settings] !== undefined)
          if (first) select(first.id)
        }
        return false
      }
      setErrors({})
      setModel(m => ({
        stored: { ...m.stored, ...byId(result.namespaces) },
        drafts: { ...m.drafts, ...Object.fromEntries(result.namespaces.map(n => [n.id, clone(n.value)])) }
      }))
      if (result.saveError !== undefined) {
        setNotice({ severity: 'warning', text: `Your changes are in effect, but could not be saved for next time: ${result.saveError}` })
        return false
      }
      return true
    } catch (err) {
      setNotice({ severity: 'error', text: `Your changes could not be applied: ${message(err)}` })
      return false
    } finally {
      setBusy(false)
    }
  }

  const ok = async () => { if (await apply()) onClose() }
  const cancel = () => {
    if (busy) return
    if (dirty.length > 0) setConfirming(true)
    else onClose()
  }

  const namespace = page?.settings === undefined ? undefined : model.stored[page.settings]
  const draft = page?.settings === undefined ? undefined : model.drafts[page.settings]

  /** What Restore Defaults gives the page's namespace: its fields' defaults, or for a page of its own, all of them. */
  const restored = (() => {
    if (!page || !namespace || !draft || namespace.readOnly !== undefined) return undefined
    if (!page.fields) return clone(namespace.defaults)
    return page.fields.reduce((value, field) => setAtPath(value, field.key, getAtPath(namespace.defaults, field.key)!), draft)
  })()

  return (
    <Dialog open onClose={cancel} maxWidth="md" fullWidth aria-labelledby={titleId} data-settings-dialog>
      <DialogTitle id={titleId}>Options</DialogTitle>

      <DialogContent dividers sx={{ p: 0, display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', height: 'min(560px, 70vh)' }}>
        {pages.length === 0
          ? <Typography sx={{ p: 2, gridColumn: '1 / -1' }} color="text.secondary">No plugin has settings to change.</Typography>
          : <>
              <PageTree pages={pages} selected={selected} query={query} onQuery={setQuery} onSelect={select}
                hasProblem={p => invalid[p.id] === true || (p.settings !== undefined && errors[p.settings] !== undefined)} />

              <Box sx={{ overflow: 'auto', p: 2, minWidth: 0 }}>
                {notice && <Alert severity={notice.severity} sx={{ mb: 2 }} onClose={() => setNotice(undefined)}>{notice.text}</Alert>}
                {pages.filter(p => visited.has(p.id)).map(p => {
                  const id = p.settings
                  const snapshot = id === undefined ? undefined : model.stored[id]
                  return (
                    <PageFrame key={p.id} page={p} hidden={p.id !== selected} errors={id === undefined ? [] : errors[id] ?? []}
                      readOnly={snapshot?.readOnly} subpages={pages.filter(child => child.parent === p.id)} onSelect={select}>
                      {id !== undefined && snapshot && model.drafts[id] && (
                        <PageContent page={p} loader={loader} builtIns={builtIns} chooseFolder={chooseFolder} props={{
                          value: model.drafts[id],
                          defaults: snapshot.defaults,
                          onChange: handlers[p.id].onChange,
                          onValidityChange: handlers[p.id].onValidityChange,
                          disabled: busy || snapshot.readOnly !== undefined,
                          errors: errors[id] ?? []
                        }} />
                      )}
                    </PageFrame>
                  )
                })}
              </Box>
            </>}
      </DialogContent>

      <DialogActions>
        <Button disabled={busy || restored === undefined || deepEqual(restored, draft)}
          onClick={() => { if (page?.settings !== undefined && restored) setDraft(page.settings, restored) }}>
          Restore Defaults
        </Button>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {elsewhere && (
            <Button size="small" color="error" startIcon={<Icon name="Error" fontSize="small" />}
              onClick={() => { setQuery(''); select(elsewhere.id) }}>
              Correct “{elsewhere.title}” to apply
            </Button>
          )}
        </Box>
        <Button onClick={cancel} disabled={busy}>Cancel</Button>
        <Button onClick={() => { void apply() }} disabled={busy || anyInvalid || dirty.length === 0}>Apply</Button>
        <Button variant="contained" onClick={() => { void ok() }} disabled={busy || anyInvalid}>OK</Button>
      </DialogActions>

      <Dialog open={confirming} onClose={() => setConfirming(false)} maxWidth="xs" aria-labelledby={`${titleId}-discard`}>
        <DialogTitle id={`${titleId}-discard`}>Discard your changes?</DialogTitle>
        <DialogContent>
          <Typography>The settings you changed have not been applied. Closing now loses those changes.</Typography>
        </DialogContent>
        <DialogActions>
          <Button autoFocus onClick={() => setConfirming(false)}>Keep Editing</Button>
          <Button color="error" onClick={() => { setConfirming(false); onClose() }}>Discard</Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  )
}

/** The list of pages, indented under their parents, with the search box above it. */
function PageTree({ pages, selected, query, onQuery, onSelect, hasProblem }: {
  pages: SettingsPageInfo[]
  selected?: string
  query: string
  onQuery(query: string): void
  onSelect(id: string): void
  hasProblem(page: SettingsPageInfo): boolean
}) {
  const { shown, matched } = useMemo(() => searchPages(pages, query), [pages, query])
  const depth = useMemo(() => {
    const byId = new Map(pages.map(p => [p.id, p]))
    const depthOf = (page: SettingsPageInfo, seen = 0): number =>
      page.parent === undefined || seen > pages.length ? 0 : 1 + depthOf(byId.get(page.parent)!, seen + 1)
    return new Map(pages.map(p => [p.id, depthOf(p)]))
  }, [pages])
  const rows = pages.filter(p => shown.has(p.id))

  // Enter in the search box goes to the first page it found
  const onKeyDown = (event: KeyboardEvent) => {
    const first = pages.find(p => matched.has(p.id))
    if (event.key === 'Enter' && first) {
      event.preventDefault()
      onSelect(first.id)
    }
  }

  return (
    <Box component="nav" aria-label="Settings pages" sx={{ borderRight: 1, borderColor: 'divider', overflow: 'auto', p: 1, minWidth: 0 }}>
      <TextField size="small" fullWidth placeholder="Search" value={query} onChange={event => onQuery(event.target.value)} onKeyDown={onKeyDown}
        slotProps={{ htmlInput: { 'aria-label': 'Search settings' } }} sx={{ mb: 1 }} />
      {rows.length === 0
        ? <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>No settings match “{query}”.</Typography>
        : <List dense disablePadding>
            {rows.map(page => {
              const problem = hasProblem(page)
              return (
                <ListItemButton key={page.id} selected={page.id === selected} aria-current={page.id === selected ? 'page' : undefined}
                  onClick={() => onSelect(page.id)} sx={{ pl: 1 + 2 * (depth.get(page.id) ?? 0), borderRadius: 1 }} data-page-id={page.id}>
                  <ListItemText primary={page.title}
                    slotProps={{ primary: { sx: { color: matched.has(page.id) ? undefined : 'text.secondary' } } }} />
                  {problem && <Icon name="Error" color="error" fontSize="small" titleAccess="Has a problem" />}
                </ListItemButton>
              )
            })}
          </List>}
    </Box>
  )
}

/** A page's title, description and messages around its content; for a category, the pages under it. */
function PageFrame({ page, hidden, errors, readOnly, subpages, onSelect, children }: {
  page: SettingsPageInfo
  hidden: boolean
  errors: readonly string[]
  readOnly?: string
  /** The pages directly under this one, listed by a category. */
  subpages: SettingsPageInfo[]
  onSelect(id: string): void
  children?: ReactNode
}) {
  const titleId = useId()
  const isCategory = page.fields === undefined && page.module === undefined
  return (
    <Box role="region" aria-labelledby={titleId} hidden={hidden} data-page-id={page.id}>
      <Typography id={titleId} variant="h6" component="h2">{page.title}</Typography>
      {page.description && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{page.description}</Typography>}
      <Stack spacing={1} sx={{ mt: 2 }}>
        {readOnly && <Alert severity="info">{readOnly}</Alert>}
        {errors.length > 0 && (
          <Alert severity="error">
            {errors.length === 1 ? errors[0] : <Box component="ul" sx={{ m: 0, pl: 2 }}>{errors.map(e => <li key={e}>{e}</li>)}</Box>}
          </Alert>
        )}
      </Stack>
      <Box sx={{ mt: 2 }}>
        {isCategory
          ? <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
              {subpages.length === 0
                ? <Typography variant="body2" color="text.secondary">There is nothing to set here.</Typography>
                : subpages.map(child => <Button key={child.id} size="small" onClick={() => onSelect(child.id)}>{child.title}</Button>)}
            </Stack>
          : children}
      </Box>
    </Box>
  )
}

/** The page's form or component, each in its own error boundary and loading placeholder. */
function PageContent({ page, loader, builtIns, chooseFolder, props }: {
  page: SettingsPageInfo
  loader: ViewLoader
  chooseFolder(request: SettingsChooseFolder): Promise<string | undefined>
  builtIns: Readonly<Record<string, SettingsPageComponent>>
  props: SettingsPageProps
}) {
  const Content = useMemo<SettingsPageComponent | undefined>(() => {
    if (page.module === undefined) return undefined
    const builtIn = page.remoteEntry === undefined ? builtIns[page.module] : undefined
    if (builtIn) return builtIn
    const remoteEntry = page.remoteEntry
    if (remoteEntry === undefined) return missing(`"${page.pluginId}" has no renderer to show ${page.module} with`)
    return lazy(async () => ({ default: await loader.load({ id: page.id, pluginId: page.pluginId, module: page.module!, remoteEntry }) }))
  }, [page, loader, builtIns])

  if (page.fields) return <FieldsPage {...props} fields={page.fields} chooseFolder={chooseFolder} />
  if (!Content) return null
  return (
    <PageBoundary pageId={page.id}>
      <Suspense fallback={<Loading>Loading {page.title}…</Loading>}>
        <Content {...props} />
      </Suspense>
    </PageBoundary>
  )
}

const missing = (why: string): SettingsPageComponent => () => { throw new Error(why) }

class PageBoundary extends Component<{ pageId: string, children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[settings] Settings page "${this.props.pageId}" failed`, error, info.componentStack)
  }

  render() {
    return this.state.failed ? <Alert severity="error">This page could not be displayed.</Alert> : this.props.children
  }
}
