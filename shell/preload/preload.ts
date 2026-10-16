import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE_CHANNEL, IpcRequest, IpcResponse, TesseraBridge } from '../../shared/ipc'

const api: TesseraBridge = {
  invoke: async <TRes>(channel: string, data?: unknown) => {
    const request: IpcRequest = { channel, data }
    const response: IpcResponse<TRes> = await ipcRenderer.invoke(INVOKE_CHANNEL, request)
    if (response.ok) return response.data
    // contextBridge only preserves an Error's message, so the code travels in it.
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
}

contextBridge.exposeInMainWorld('api', api)
