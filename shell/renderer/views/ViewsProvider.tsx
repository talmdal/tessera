// shell/renderer/views/ViewsProvider.tsx
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
import type { ViewDescriptor } from '../../../shared/views/types'
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
 * Renders the views contributed to a slot, in order. Each view loads and fails
 * independently; `fallback` is shown when the slot has no views.
 */
export function Slot({ id, fallback = null }: { id: string, fallback?: ReactNode }) {
  const views = useViewCatalogue()
  if (!views) return null

  const inSlot = views.filter(view => view.slot === id)
  if (inSlot.length === 0) return <>{fallback}</>

  return (
    <>
      {inSlot.map(view => <ViewPane key={view.id} view={view} />)}
    </>
  )
}

/** Every valid view, present or not. Undefined until the list has been fetched. */
export function useViewCatalogue(): ViewDescriptor[] | undefined {
  return useViewsContext().views
}

function useViewsContext() {
  const context = useContext(ViewsContext)
  if (!context) throw new Error('<Slot> must be rendered inside <ViewsProvider>')
  return context
}

/**
 * One view in its own section, with its own loading placeholder and error
 * boundary. `hidden` keeps it mounted but out of sight and out of the
 * accessibility tree, so its state survives while another view is shown.
 */
export function ViewPane({ view, hidden = false }: { view: ViewDescriptor, hidden?: boolean }) {
  const View = useViewsContext().componentFor(view)
  return (
    <section aria-label={view.title} data-view-id={view.id} hidden={hidden} tabIndex={-1}>
      <ViewBoundary view={view}>
        <Suspense fallback={<p>Loading {view.title}…</p>}>
          <View />
        </Suspense>
      </ViewBoundary>
    </section>
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
