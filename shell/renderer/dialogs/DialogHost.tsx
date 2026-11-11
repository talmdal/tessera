// shell/renderer/dialogs/DialogHost.tsx
import { Component, ErrorInfo, ReactNode, Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DialogProps, TesseraBridge } from '@tessera/types'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@tessera/ui'
import { DIALOG_CLOSE, DIALOG_DISMISS, DIALOG_OPEN, DialogClose, DialogDismiss, DialogOpen } from '../../../shared/dialogs/types'
import { Loading } from '../Loading'
import { useWindowTheme } from '../theme/ShellThemeProvider'
import type { ViewLoader } from '../views/ports'
import { BUILT_IN_DIALOGS, DialogComponent } from './builtIns'

type Bridge = Pick<TesseraBridge, 'invoke' | 'on'>
type Outcome = { result?: unknown } | { error: string }

/**
 * Shows the dialogs the main process sends to this window (`shell.prompts.show`), one at a time, in the order they
 * were asked for. The shell draws the frame and the title; the dialog's component, loaded from its plugin's remote
 * (or built in, for the shell's own), draws the content and buttons. Each answer goes back as `shell:dialog.close`.
 */
export function DialogHost({ bridge, loader, builtIns = BUILT_IN_DIALOGS }: {
  bridge: Bridge
  loader: ViewLoader
  builtIns?: Readonly<Record<string, DialogComponent>>
}) {
  const { windowId } = useWindowTheme()
  const [queue, setQueue] = useState<DialogOpen[]>([])

  useEffect(() => bridge.on<DialogOpen>(DIALOG_OPEN, request => {
    if (request.windowId !== windowId) return
    // The main process sends a request again when the page may have missed it; one already queued is kept as is.
    setQueue(current => current.some(r => r.requestId === request.requestId) ? current : [...current, request])
  }), [bridge, windowId])

  // Cancelled from the main process (the app is quitting): taken down, with no answer to send
  useEffect(() => bridge.on<DialogDismiss>(DIALOG_DISMISS, ({ windowId: target, requestId }) => {
    if (target !== windowId) return
    setQueue(current => current.filter(r => r.requestId !== requestId))
  }), [bridge, windowId])

  const finish = useCallback((request: DialogOpen, outcome: Outcome) => {
    setQueue(current => current.filter(r => r.requestId !== request.requestId))
    const message: DialogClose = { requestId: request.requestId, ...outcome }
    bridge.invoke(DIALOG_CLOSE, message).catch(err => console.error(`[dialogs] Could not report how "${request.dialog.id}" closed`, err))
  }, [bridge])

  const current = queue[0]
  if (!current) return null
  return <HostedDialog key={current.requestId} request={current} loader={loader} builtIns={builtIns} onFinish={outcome => finish(current, outcome)} />
}

function HostedDialog({ request, loader, builtIns, onFinish }: {
  request: DialogOpen
  loader: ViewLoader
  builtIns: Readonly<Record<string, DialogComponent>>
  onFinish(outcome: Outcome): void
}) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()

  // The component may call close more than once (a double click); only the first counts.
  const finished = useRef(false)
  const finishRef = useRef(onFinish)
  finishRef.current = onFinish
  const finish = useCallback((outcome: Outcome) => {
    if (finished.current) return
    finished.current = true
    finishRef.current(outcome)
  }, [])

  const Content = useMemo<DialogComponent>(() => {
    const { dialog } = request
    if (dialog.remoteEntry === undefined) {
      return builtIns[dialog.module] ?? missing(`The shell has no built-in dialog ${dialog.module}`)
    }
    const remote = { id: dialog.id, pluginId: dialog.pluginId, module: dialog.module, remoteEntry: dialog.remoteEntry }
    return lazy(async () => ({ default: await loader.load(remote) }))
  }, [request, loader, builtIns])

  const props = useMemo<DialogProps>(() => ({
    input: request.input,
    close: (result?: unknown) => finish(result === undefined ? {} : { result }),
    setBusy: (value: boolean) => setBusy(Boolean(value))
  }), [request, finish])

  // Escape and clicking outside: cancel, unless the dialog is busy. A dialog that failed reports why.
  const dismiss = () => {
    if (failure !== undefined) finish({ error: failure })
    else if (!busy) finish({})
  }

  return (
    <Dialog open onClose={dismiss} maxWidth={request.dialog.size} fullWidth aria-labelledby={titleId} data-dialog-id={request.dialog.id}>
      <DialogTitle id={titleId}>{request.title}</DialogTitle>
      {failure !== undefined
        ? <>
            <DialogContent><Alert severity="error">This dialog could not be displayed.</Alert></DialogContent>
            <DialogActions><Button onClick={dismiss}>Close</Button></DialogActions>
          </>
        : <DialogBoundary dialogId={request.dialog.id} onError={setFailure}>
            <Suspense fallback={<DialogContent><Loading>Loading…</Loading></DialogContent>}>
              <Content {...props} />
            </Suspense>
          </DialogBoundary>}
    </Dialog>
  )
}

const missing = (message: string): DialogComponent => () => { throw new Error(message) }

class DialogBoundary extends Component<{ dialogId: string, onError(message: string): void, children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[dialogs] Dialog "${this.props.dialogId}" failed`, error, info.componentStack)
    this.props.onError(error instanceof Error ? error.message : String(error))
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
