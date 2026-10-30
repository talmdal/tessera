// tests/helpers/tempDir.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A fresh folder under the OS temp dir, e.g. tessera-sqlite-Ab12Cd. */
export function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

/**
 * Removes a folder a test made. Retries, because on Windows a file stays
 * locked for a moment after its last handle closes (and indexers or
 * antivirus can hold one briefly), which makes an immediate delete fail
 * with EPERM or EBUSY.
 */
export function removeDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
