import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/dist-preload/index.js')
    }
  })

  win.loadURL('http://localhost:5173')
}

ipcMain.handle('get-version', () => app.getVersion())
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
