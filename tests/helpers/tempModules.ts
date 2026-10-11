// tests/helpers/tempModules.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function createTempModulesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-modules-'))
  return dir
}
