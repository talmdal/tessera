// shell/renderer/options/OptionsDialog.tsx
import { Component, ErrorInfo, KeyboardEvent, ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { Json, OptionsPageProps, TesseraBridge } from '@tessera/types'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemText,
  Stack, TextField, Typography
} from '@tessera/ui'
import {
  OPTIONS_CLOSED, OPTIONS_COMMIT, OPTIONS_GET, OPTIONS_OPEN, OPTIONS_PAGES, OptionsClosed, OptionsCommit,
  OptionsGet, OptionsOpen, OptionsPageNode, OptionsValues
} from '../../../shared/options/types'
import { cloneValue, equalValues } from '../../../shared/options/values'
import { Loading } from '../Loading'
import { useWindowTheme } from '../theme/ShellThemeProvider'
import type { ViewLoader } from '../views/ports'
import { BUILT_IN_OPTION_PAGES, OptionsPageComponent } from './builtIns'
import { reportCaught } from '../problems/reportWindowErrors'

type Bridge = Pick<TesseraBridge, 'invoke' | 'on'>

/**
 * One namespace's edit state. The draft belongs to the dialog session: every page of the namespace edits the
 * same draft, and nothing reaches the application until the user applies it (decisions 2 and 4).
 */
type Draft =
  | { state: 'loading' }
  | { state: 'unregistered' }
  | { state: 'ready', baseline: Json, draft: Json, defaults: Json }

/**
 * Opens the options dialog in this window when the main process says so (Tools ▸ Options…). The page tree is
 * fetched as it opens; the event's session is what the edit channels demand, and dies when the dialog closes.
 */
export function OptionsDialog({ bridge, loader, builtIns = BUILT_IN_OPTION_PAGES }: {
  bridge: Bridge
  loader: ViewLoader
  builtIns?: Readonly<Record<string, OptionsPageComponent>>
}) {
  const { windowId } = useWindowTheme()
  const [open, setOpen] = useState<{ session: string, pages: OptionsPageNode[] }>()

  useEffect(() => bridge.on<OptionsOpen>(OPTIONS_OPEN, request => {
    if (request.windowId !== windowId) return
    // Asking again for the dialog that is already up leaves it exactly as it is, drafts and all.
    setOpen(current => {
      if (current?.session === request.session) return current
      bridge.invoke<OptionsPageNode[]>(OPTIONS_PAGES).then(
        pages => setOpen({ session: request.session, pages }),
        err => console.error('[options] Could not open the options dialog', err))
      return current
    })
  }), [bridge, windowId])

  if (!open) return null

  const close = () => {
    setOpen(undefined)
    bridge.invoke(OPTIONS_CLOSED, { session: open.session } satisfies OptionsClosed)
      .catch(err => console.error('[options] Could not report that the dialog closed', err))
  }

  return <OptionsFrame key={open.session} session={open.session} pages={open.pages} bridge={bridge} loader={loader} builtIns={builtIns} onClose={close} />
}

/** Every node of the tree, depth first, each with how deep it sits. */
function flatten(pages: readonly OptionsPageNode[], depth = 0): { node: OptionsPageNode, depth: number }[] {
  return pages.flatMap(node => [{ node, depth }, ...flatten(node.children, depth + 1)])
}

/**
 * The first node that can actually show something: a category only groups pages, so selecting one shows its
 * first page instead of an empty panel.
 */
function firstPage(node: OptionsPageNode): OptionsPageNode | undefined {
  if (node.module) return node
  for (const child of node.children) {
    const found = firstPage(child)
    if (found) return found
  }
  return undefined
}

export function OptionsFrame({ session, pages, bridge, loader, builtIns = BUILT_IN_OPTION_PAGES, onClose }: {
  session: string
  pages: readonly OptionsPageNode[]
  bridge: Bridge
  loader: ViewLoader
  builtIns?: Readonly<Record<string, OptionsPageComponent>>
  onClose(): void
}) {
  const rows = useMemo(() => flatten(pages), [pages])
  const initial = useMemo(() => pages.map(firstPage).find(Boolean) ?? rows[0]?.node, [pages, rows])
  const [selectedId, setSelectedId] = useState(initial?.id)
  const [query, setQuery] = useState('')

  /** Who sits above whom, for the search: a match brings its ancestors (context) and its descendants (content). */
  const parents = useMemo(() => {
    const map = new Map<string, string | undefined>()
    const walk = (nodes: readonly OptionsPageNode[], parent?: string) => {
      for (const node of nodes) { map.set(node.id, parent); walk(node.children, node.id) }
    }
    walk(pages)
    return map
  }, [pages])

  const visibleRows = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    if (!wanted) return rows
    const matched = new Set(rows
      .filter(({ node }) => node.title.toLowerCase().includes(wanted) || node.keywords.some(k => k.toLowerCase().includes(wanted)))
      .map(row => row.node.id))

    const shown = new Set<string>()
    for (const id of matched) {
      for (let current: string | undefined = id; current !== undefined && !shown.has(current); current = parents.get(current)) shown.add(current)
    }
    const underMatch = (id: string | undefined): boolean => id !== undefined && (matched.has(id) || underMatch(parents.get(id)))
    for (const { node } of rows) { if (underMatch(node.id)) shown.add(node.id) }

    return rows.filter(row => shown.has(row.node.id))
  }, [rows, parents, query])

  // A search that hides the selected page moves the selection to the first page still in sight.
  useEffect(() => {
    if (visibleRows.length === 0 || visibleRows.some(row => row.node.id === selectedId)) return
    setSelectedId((visibleRows.find(row => row.node.module) ?? visibleRows[0]).node.id)
  }, [visibleRows, selectedId])

  const itemRefs = useRef<(HTMLElement | null)[]>([])
  const searchRef = useRef<HTMLInputElement | null>(null)

  /**
   * Arrow keys walk the visible rows from anywhere in the navigation column — including the search field, where
   * the dialog puts the focus when it opens. Searching and choosing are then one gesture: type, arrow down to
   * the page you meant, and the focus stays in the field so you can keep typing. Coming from a row instead, the
   * focus follows the selection, so the keyboard user stays where they are looking.
   * A category reached this way shows its own panel rather than redirecting, so traversal never jumps.
   */
  const onNavKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const last = visibleRows.length - 1
    if (last < 0) return
    const current = visibleRows.findIndex(row => row.node.id === selectedId)
    const from = current < 0 ? 0 : current
    const target = event.key === 'ArrowDown' ? Math.min(from + 1, last)
      : event.key === 'ArrowUp' ? Math.max(from - 1, 0)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined
    if (target === undefined) return

    event.preventDefault()
    setSelectedId(visibleRows[target].node.id)
    if (event.target !== searchRef.current) itemRefs.current[target]?.focus()
  }

  /** The session's draft set, one entry per namespace, made as pages are first visited. */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  /** Validation messages per namespace: the main process's answer to the last Apply. */
  const [problems, setProblems] = useState<Record<string, string[]>>({})
  /** Pages that told us their editors hold something unusable (onValidityChange). UX only. */
  const [invalidPages, setInvalidPages] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmingRestore, setConfirmingRestore] = useState(false)
  /** How the last Apply went, when it partly failed: which namespaces were saved and which were not. */
  const [outcome, setOutcome] = useState<{ saved: string[], failed: string[] }>()
  const [failure, setFailure] = useState<string>()

  const selected = rows.find(row => row.node.id === selectedId)?.node ?? initial
  const select = (node: OptionsPageNode) => setSelectedId((firstPage(node) ?? node).id)

  // Seed the selected page's namespace draft from the stored value, once per session.
  const namespace = selected?.module ? selected.pluginId : undefined
  useEffect(() => {
    if (!namespace || drafts[namespace]) return
    setDrafts(current => ({ ...current, [namespace]: { state: 'loading' } }))
    bridge.invoke<OptionsValues | null>(OPTIONS_GET, { session, namespace } satisfies OptionsGet).then(
      values => setDrafts(current => ({
        ...current,
        [namespace]: values === null
          ? { state: 'unregistered' }
          : { state: 'ready', baseline: values.value as Json, draft: cloneValue(values.value as Json), defaults: values.defaults as Json }
      })),
      err => {
        console.error('[options] Could not read the options', err)
        setFailure(err instanceof Error ? err.message : String(err))
      })
  }, [bridge, session, namespace, drafts])

  const ready = (entry: Draft | undefined): entry is Draft & { state: 'ready' } => entry?.state === 'ready'
  const isDirty = (entry: Draft | undefined) => ready(entry) && !equalValues(entry.draft, entry.baseline)
  const dirty = Object.entries(drafts).filter(([, entry]) => isDirty(entry))
  const dirtyNamespaces = new Set(dirty.map(([ns]) => ns))
  const someInvalid = Object.values(invalidPages).some(Boolean)

  const setDraft = (ns: string, value: Json) => {
    setDrafts(current => {
      const entry = current[ns]
      return ready(entry) ? { ...current, [ns]: { ...entry, draft: value } } : current
    })
    // The last save's verdict is about a value the user has just changed, so it stops applying to this page.
    setProblems(current => {
      if (!(ns in current)) return current
      const { [ns]: _gone, ...rest } = current
      return rest
    })
    setOutcome(current => {
      if (!current) return current
      const failed = current.failed.filter(namespace => namespace !== ns)
      return failed.length === 0 ? undefined : { saved: current.saved.filter(namespace => namespace !== ns), failed }
    })
  }

  /** Saves every dirty namespace. True when everything that was dirty is now stored. */
  const apply = async (): Promise<boolean> => {
    if (dirty.length === 0) return true
    setBusy(true)
    try {
      const changes = Object.fromEntries(dirty.map(([ns, entry]) => [ns, (entry as Draft & { state: 'ready' }).draft]))
      const results = await bridge.invoke<Record<string, string[]>>(
        OPTIONS_COMMIT, { session, changes } satisfies OptionsCommit)

      // What saved is the new baseline; what failed keeps its draft and shows why.
      setDrafts(current => {
        const next = { ...current }
        for (const ns of Object.keys(changes)) {
          const entry = next[ns]
          if (ready(entry) && (results[ns] ?? []).length === 0) next[ns] = { ...entry, baseline: cloneValue(entry.draft) }
        }
        return next
      })
      const failed = Object.fromEntries(Object.entries(results).filter(([, messages]) => messages.length > 0))
      setProblems(failed)

      const failing = Object.keys(failed)
      if (failing.length > 0) {
        // Say plainly what was saved and what was not, and keep the user where the problem is.
        setOutcome({ saved: Object.keys(changes).filter(ns => (results[ns] ?? []).length === 0), failed: failing })
        const page = rows.find(row => row.node.module && row.node.pluginId === failing[0])
        if (page) {
          setSelectedId(page.node.id)
          // Taking the user to a page a search is hiding would bounce them straight back off it.
          if (!visibleRows.some(row => row.node.id === page.node.id)) setQuery('')
        }
        return false
      }
      setOutcome(undefined)
      return true
    } catch (err) {
      console.error('[options] Could not save the options', err)
      setFailure(err instanceof Error ? err.message : String(err))
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

  const restoreDefaults = () => {
    setConfirmingRestore(false)
    if (!namespace) return
    const entry = drafts[namespace]
    // Just another pending edit: nothing is stored until Apply or OK.
    if (ready(entry)) setDraft(namespace, cloneValue(entry.defaults))
  }

  const entry = namespace ? drafts[namespace] : undefined
  const canRestore = !busy && ready(entry) && !equalValues(entry.draft, entry.defaults)

  /** The page titles of some namespaces, for talking about them: "Backups, Ledger". */
  const titlesOf = (namespaces: readonly string[]) => {
    const set = new Set(namespaces)
    return [...new Set(rows.filter(row => row.node.module && set.has(row.node.pluginId)).map(row => row.node.title))]
  }
  /** Pages holding something their own editors call unusable: why Apply and OK are off. */
  const needingAttention = Object.entries(invalidPages)
    .filter(([, invalid]) => invalid)
    .map(([pageId]) => rows.find(row => row.node.id === pageId)?.node.title)
    .filter((title): title is string => title !== undefined)

  /**
   * Enter is the dialog's default action, as it is in any desktop dialog: OK. It is ignored while a question is
   * open over the top (those have their own default), while saving, and whenever the focus is on something that
   * does its own thing with Enter — a button, a link, a multi-line field — so a page's own controls keep working.
   */
  const onFrameKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || confirming || confirmingRestore || busy) return
    if (someInvalid || failure !== undefined) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a[href], textarea, [role="button"], [contenteditable="true"]')) return
    event.preventDefault()
    void ok()
  }

  return (
    <Dialog open onClose={cancel} maxWidth="lg" fullWidth aria-labelledby="options-title" onKeyDown={onFrameKeyDown}>
      <DialogTitle id="options-title">Options</DialogTitle>

      <DialogContent dividers sx={{ p: 0 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(0, 3fr)', minHeight: 360 }}>
          <Box onKeyDown={onNavKeyDown}
            sx={{ borderRight: 1, borderColor: 'divider', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {rows.length === 0
              ? <Typography sx={{ p: 2 }} color="text.secondary">Nothing has any options yet.</Typography>
              : (
                <>
                  <Box sx={{ p: 1 }}>
                    <TextField autoFocus fullWidth size="small" placeholder="Search"
                      value={query} onChange={event => setQuery(event.target.value)}
                      inputRef={searchRef}
                      slotProps={{ htmlInput: { 'aria-label': 'Search options' } }} />
                  </Box>
                  {visibleRows.length === 0
                    ? <Typography sx={{ p: 2 }} color="text.secondary">Nothing matches “{query.trim()}”.</Typography>
                    : (
                      <List dense disablePadding aria-label="Option pages" sx={{ overflowY: 'auto' }}>
                        {visibleRows.map(({ node, depth }, index) => {
                          const failing = node.module !== undefined && (problems[node.pluginId] ?? []).length > 0
                          const dirty = node.module !== undefined && dirtyNamespaces.has(node.pluginId)
                          return (
                            <ListItemButton key={node.id} selected={node.id === selected?.id}
                              ref={element => { itemRefs.current[index] = element }}
                              aria-current={node.id === selected?.id ? 'page' : undefined}
                              onClick={() => select(node)}
                              // Only the selected row is a tab stop: Tab reaches the tree, then leaves it, and
                              // the arrow keys move within — the usual bargain for a list of this length.
                              tabIndex={node.id === selected?.id ? 0 : -1}
                              sx={{ pl: 2 + depth * 2 }}>
                              <ListItemText
                                primary={`${node.title}${failing ? ' ⚠' : ''}${dirty ? ' •' : ''}`}
                                primaryTypographyProps={{
                                  variant: node.module ? 'body2' : 'subtitle2',
                                  ...(failing && { color: 'error' })
                                }} />
                            </ListItemButton>
                          )
                        })}
                      </List>
                    )}
                </>
              )}
          </Box>

          <Box sx={{ p: 3, overflowY: 'auto' }}>
            {failure !== undefined
              ? <Alert severity="error">Something went wrong: {failure}</Alert>
              : selected
                ? (
                  <Stack spacing={2}>
                    {outcome && outcome.failed.length > 0 && (
                      <Alert severity="warning">
                        {outcome.saved.length > 0 && <>Your changes to {titlesOf(outcome.saved).join(', ')} were saved. </>}
                        Your changes to {titlesOf(outcome.failed).join(', ')} could not be: the problems are shown on
                        each page, and nothing of theirs was saved.
                      </Alert>
                    )}
                    <Typography variant="h6" component="h3">{selected.title}</Typography>
                    {(problems[selected.pluginId] ?? []).map((message, index) => (
                      <Alert key={index} severity="error">{message}</Alert>
                    ))}
                    <PageArea key={selected.id} page={selected} entry={entry} loader={loader} builtIns={builtIns} disabled={busy}
                      onChange={value => namespace && setDraft(namespace, value)}
                      onValidityChange={valid => setInvalidPages(current => ({ ...current, [selected.id]: !valid }))} />
                  </Stack>
                )
                : <Typography color="text.secondary">Select a page.</Typography>}
          </Box>
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={() => setConfirmingRestore(true)} disabled={!canRestore}>Restore Defaults</Button>
        <Box sx={{ mr: 'auto', pl: 1 }}>
          {needingAttention.length > 0 && (
            <Typography variant="caption" color="error">
              “{needingAttention[0]}” needs attention before anything can be saved.
            </Typography>
          )}
        </Box>
        <Button onClick={cancel} disabled={busy}>Cancel</Button>
        <Button onClick={() => { void apply() }} disabled={busy || dirty.length === 0 || someInvalid}>Apply</Button>
        <Button variant="contained" onClick={() => { void ok() }} disabled={busy || someInvalid}>OK</Button>
      </DialogActions>

      {confirmingRestore && selected && (
        <Dialog open onClose={() => setConfirmingRestore(false)} maxWidth="xs" aria-labelledby="options-restore-title">
          <DialogTitle id="options-restore-title">Restore the defaults?</DialogTitle>
          <DialogContent>
            <Typography>
              “{selected.title}” goes back to its defaults. Like any other edit, nothing is saved until you apply.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button autoFocus onClick={() => setConfirmingRestore(false)}>Keep My Settings</Button>
            <Button color="error" onClick={restoreDefaults}>Restore</Button>
          </DialogActions>
        </Dialog>
      )}

      {confirming && (
        <Dialog open onClose={() => setConfirming(false)} maxWidth="xs" aria-labelledby="options-discard-title">
          <DialogTitle id="options-discard-title">Discard your changes?</DialogTitle>
          <DialogContent>
            <Typography>What you changed has not been saved.</Typography>
          </DialogContent>
          <DialogActions>
            <Button autoFocus onClick={() => setConfirming(false)}>Keep Editing</Button>
            <Button color="error" onClick={onClose}>Discard</Button>
          </DialogActions>
        </Dialog>
      )}
    </Dialog>
  )
}

/** The selected page: its component when it has one and its namespace is real, otherwise what is wrong. */
function PageArea({ page, entry, loader, builtIns, disabled, onChange, onValidityChange }: {
  page: OptionsPageNode
  entry: Draft | undefined
  loader: ViewLoader
  builtIns: Readonly<Record<string, OptionsPageComponent>>
  disabled: boolean
  onChange(value: Json): void
  onValidityChange(valid: boolean): void
}) {
  if (!page.module) {
    return (
      <Typography color="text.secondary">
        {page.children.length > 0 ? 'This group has no page of its own.' : 'This group has no pages of its own.'}
      </Typography>
    )
  }
  if (!entry || entry.state === 'loading') return <Loading>Loading…</Loading>
  if (entry.state === 'unregistered') {
    return <Alert severity="warning">The plugin “{page.pluginId}” contributed this page but registered no options.</Alert>
  }
  return <HostedPage page={page} entry={entry} loader={loader} builtIns={builtIns} disabled={disabled}
    onChange={onChange} onValidityChange={onValidityChange} />
}

const missing = (message: string): OptionsPageComponent => () => { throw new Error(message) }

function HostedPage({ page, entry, loader, builtIns, disabled, onChange, onValidityChange }: {
  page: OptionsPageNode
  entry: Draft & { state: 'ready' }
  loader: ViewLoader
  builtIns: Readonly<Record<string, OptionsPageComponent>>
  disabled: boolean
  onChange(value: Json): void
  onValidityChange(valid: boolean): void
}) {
  const [failed, setFailed] = useState(false)

  const Content = useMemo(() => {
    // The shell's own pages are built in, as its dialogs are; everything else comes from its plugin's remote.
    if (page.remoteEntry === undefined) {
      return builtIns[page.module!] ?? missing(`The shell has no built-in options page ${page.module}`)
    }
    return lazy(async () => ({
      default: await loader.load({ id: page.id, pluginId: page.pluginId, module: page.module!, remoteEntry: page.remoteEntry! })
    }))
  }, [loader, page, builtIns])

  const props = {
    value: entry.draft,
    defaults: entry.defaults,
    onChange,
    onValidityChange,
    disabled
  } satisfies OptionsPageProps<Json>

  if (failed) return <Alert severity="error">“{page.title}” could not be displayed.</Alert>
  return (
    <PageBoundary pageId={page.id} onError={() => setFailed(true)}>
      <Suspense fallback={<Loading>Loading…</Loading>}>
        <Content {...props} />
      </Suspense>
    </PageBoundary>
  )
}

/** One page crashing costs that page, never the dialog: the tree and the other pages still work. */
class PageBoundary extends Component<{ pageId: string, onError(): void, children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[options] Page "${this.props.pageId}" failed`, error, info.componentStack)
    reportCaught(`Options page "${this.props.pageId}" could not be displayed`, error, info.componentStack)
    this.props.onError()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
