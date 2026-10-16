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
    source.listViews().then(
      list => { if (live) setViews(list) },
      err => {
        console.error('[views] Failed to list views', err)
        if (live) setViews([])
      })
    return () => { live = false }
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
  const context = useContext(ViewsContext)
  if (!context) throw new Error('<Slot> must be rendered inside <ViewsProvider>')

  const { views, componentFor } = context
  if (!views) return null

  const inSlot = views.filter(view => view.slot === id)
  if (inSlot.length === 0) return <>{fallback}</>

  return (
    <>
      {inSlot.map(view => {
        const View = componentFor(view)
        return (
          <section key={view.id} aria-label={view.title} data-view-id={view.id}>
            <ViewBoundary view={view}>
              <Suspense fallback={<p>Loading {view.title}…</p>}>
                <View />
              </Suspense>
            </ViewBoundary>
          </section>
        )
      })}
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
