// shell/main/fonts/electronFontProbe.ts — lists installed fonts with Chromium's Local Font Access API, from a hidden
// window of its own that alone is granted the `local-fonts` permission. See docs/font-roles-design.md.
import type { BrowserWindow as ElectronBrowserWindow, Session } from 'electron'
import type { FontCataloguePort } from './fontCatalogue'

/**
 * The probe's session: in memory (no `persist:`), and used by nothing else, so the permission handlers set on it
 * concern the probe alone. The application's windows keep their own session, untouched.
 */
export const FONT_PROBE_PARTITION = 'tessera-font-probe'

/** Run in the probe page: every installed face, reduced to its family names. */
export const FONT_PROBE_SCRIPT = 'queryLocalFonts().then(fonts => [...new Set(fonts.map(font => font.family))])'

export interface FontProbeElectron {
  BrowserWindow: new (options: Electron.BrowserWindowConstructorOptions) => Pick<ElectronBrowserWindow, 'loadFile' | 'destroy' | 'isDestroyed'> & {
    webContents: Pick<ElectronBrowserWindow['webContents'], 'id' | 'executeJavaScript'>
  }
  session: { fromPartition(partition: string): Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'> }
}

/**
 * Why a window of its own: plugin views run in the application's page, with its origin and frame, which a permission
 * handler can't tell apart, so a permission granted to that page is granted to every plugin view. The probe is a
 * hidden window on a session of its own, loading `probeFile` (a page of the shell's, from file://, so a secure
 * context, as the API needs), granted `local-fonts` by `webContents`, asked, and closed. Each call opens a new one;
 * the catalogue (fontCatalogue.ts) asks once per session.
 */
export function createElectronFontProbe({ BrowserWindow, session }: FontProbeElectron, probeFile: string): FontCataloguePort {
  return {
    async listFamilies() {
      const probeSession = session.fromPartition(FONT_PROBE_PARTITION)
      let probeId: number | undefined
      const isProbe = (webContents: { id: number } | null | undefined) => probeId !== undefined && webContents?.id === probeId
      probeSession.setPermissionCheckHandler((webContents, permission) => permission === 'local-fonts' && isProbe(webContents))
      probeSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permission === 'local-fonts' && isProbe(webContents)))

      const probe = new BrowserWindow({
        show: false, width: 200, height: 200, skipTaskbar: true, focusable: false,
        webPreferences: { partition: FONT_PROBE_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      probeId = probe.webContents.id
      try {
        await probe.loadFile(probeFile)
        // As a user gesture, in case the platform asks for one even once the permission is granted
        return await probe.webContents.executeJavaScript(FONT_PROBE_SCRIPT, true) as string[]
      } finally {
        if (!probe.isDestroyed()) probe.destroy()
      }
    }
  }
}
