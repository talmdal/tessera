import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL, IpcRequest, IpcResponse, TesseraBridge, isIpcEvent } from '../../shared/ipc'

// Push events from the main process arrive on one channel and are routed here
// by name. The renderer only ever sees an event's data, never Electron's event.
const listeners = new Map<string, Set<(data: unknown) => void>>()

ipcRenderer.on(EVENT_CHANNEL, (_event, message: unknown) => {
  if (!isIpcEvent(message)) return
  for (const listener of [...(listeners.get(message.name) ?? [])]) {
    try {
      listener(message.data)
    } catch (err) {
      console.error(`[events] A listener for ${message.name} threw`, err)
    }
  }
})

const api: TesseraBridge = {
  invoke: async <TRes>(channel: string, data?: unknown) => {
    const request: IpcRequest = { channel, data }
    const response: IpcResponse<TRes> = await ipcRenderer.invoke(INVOKE_CHANNEL, request)
    if (response.ok) return response.data
    // contextBridge only preserves an Error's message, so the code travels in it.
    throw new Error(`${response.error.code}: ${response.error.message}`)
  },

  on: (name: string, listener: (data: any) => void) => {
    let set = listeners.get(name)
    if (!set) listeners.set(name, set = new Set())
    set.add(listener)
    return () => { set.delete(listener) }
  }
}

contextBridge.exposeInMainWorld('api', api)
