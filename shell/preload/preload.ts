import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, payload?: any) =>
    ipcRenderer.invoke(channel, payload)
})
