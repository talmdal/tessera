// shell/renderer/views/ViewsProvider.tsx
import type { ViewDescriptor } from '@tessera/types'
import {
  Component,
  ComponentType,
  ErrorInfo,
  LazyExoticComponent,
  ReactNode,
  Suspense,
  createContext,
  lazy,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import { ViewLoader, ViewSource } from './ports'

interface ViewsContextValue {
  /** Undefined until the view list has been fetched. */
  views: ViewDescriptor[] | undefined
  componentFor(view: ViewDescriptor): LazyExoticComponent<ComponentType>
}

const ViewsContext = createContext<ViewsContextValue | null>(null)

export function ViewsProvider({ source, loader, children }: {
  source: ViewSource
  loader: ViewLoader
  children: ReactNode
}) {
  const [views, setViews] = useState<ViewDescriptor[]>()

  useEffect(() => {
    let live = true
    let latest = 0

    // Only the most recent request may set the list, so a slow early reply
    // can't overwrite a newer one.
    const load = () => {
      const request = ++latest
      source.listViews().then(
        list => { if (live && request === latest) setViews(list) },
        err => {
          console.error('[views] Failed to list views', err)
          if (live && request === latest) setViews(current => current ?? [])
        })
    }

    load()
    const stopListening = source.onDidChange?.(load)
    return () => {
      live = false
      stopListening?.()
    }
  }, [source])

  // One lazy component per view, so plugin code is only fetched when a slot renders it.
  const componentFor = useMemo(() => {
    const cache = new Map<string, LazyExoticComponent<ComponentType>>()
    return (view: ViewDescriptor) => {
      let component = cache.get(view.id)
      if (!component) cache.set(view.id, component = lazy(async () => ({ default: await loader.load(view) })))
      return component
    }
  }, [loader])

  const value = useMemo(() => ({ views, componentFor }), [views, componentFor])

  return <ViewsContext.Provider value={value}>{children}</ViewsContext.Provider>
}

/**
 * The view catalogue: every contributed view, present or not (presence is the
 * layout's business), and the lazy component for each.
 */
export function useViewCatalogue(): ViewsContextValue & { byId: Map<string, ViewDescriptor> } {
  const context = useContext(ViewsContext)
  if (!context) throw new Error('View hooks must be used inside <ViewsProvider>')
  const byId = useMemo(
    () => new Map((context.views ?? []).map(view => [view.id, view])),
    [context.views]
  )
  return { ...context, byId }
}

/**
 * One view in its own section: lazy-loaded, labelled, focusable (for reveal)
 * and isolated by an error boundary. `hidden` keeps an inactive tab mounted,
 * so its state survives switching, without showing it.
 */
export function ViewHost({ view, componentFor, hidden = false }: {
  view: ViewDescriptor
  componentFor(view: ViewDescriptor): LazyExoticComponent<ComponentType>
  hidden?: boolean
  /** React's list key; only here because the repo compiles without @types/react. */
  key?: string
}) {
  const View = componentFor(view)
  return (
    <section aria-label={view.title} data-view-id={view.id} tabIndex={-1} hidden={hidden}>
      <ViewBoundary view={view}>
        <Suspense fallback={<p>Loading {view.title}…</p>}>
          <View />
        </Suspense>
      </ViewBoundary>
    </section>
  )
}

/**
 * Renders the views contributed to a slot, in order. Each view loads and fails
 * independently; `fallback` is shown when the slot has no views.
 *
 * The window manager renders slots itself (with presence and tabs); <Slot> is
 * the plain form, rendering every view in the catalogue that targets the slot.
 */
export function Slot({ id, fallback = null }: { id: string, fallback?: ReactNode }) {
  const context = useContext(ViewsContext)
  if (!context) throw new Error('<Slot> must be rendered inside <ViewsProvider>')

  const { views, componentFor } = context
  if (!views) return null

  const inSlot = views.filter(view => view.slot === id)
  if (inSlot.length === 0) return <>{fallback}</>

  return (
    <>
      {inSlot.map(view => <ViewHost key={view.id} view={view} componentFor={componentFor} />)}
    </>
  )
}

class ViewBoundary extends Component<{ view: ViewDescriptor, children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[views] View "${this.props.view.id}" failed`, error, info.componentStack)
  }

  render() {
    if (this.state.failed) return <p role="alert">{this.props.view.title} could not be displayed.</p>
    return this.props.children
  }
}
