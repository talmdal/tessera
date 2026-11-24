// @vitest-environment node
// `shell.files.writeFile` (phase R6): a file written whole or not at all. Under a temporary name, then renamed over the
// file; the rename retried while another program holds the file (Windows); on any failure the temporary file removed,
// the file as it was, and a message for the user saying why.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createElectronFiles } from '../../shell/main/dialogs/electronFiles'
import { PARTIAL_SUFFIX, nodeWriteDisk, writeFailure, writeFileAtomically, type WriteDisk } from '../../shell/main/dialogs/writeFile'
import { createTempModulesDir } from '../helpers/tempModules'

const held = (code = 'EBUSY') => Object.assign(new Error(`${code}: resource busy or locked`), { code })

/** The real disk, with a rename that fails `times` times first. */
function flakyDisk(times: number, code = 'EBUSY'): WriteDisk & { renames: number } {
  const disk = {
    renames: 0,
    writeFile: nodeWriteDisk.writeFile,
    remove: nodeWriteDisk.remove,
    rename: async (from: string, to: string) => {
      disk.renames++
      if (disk.renames <= times) throw held(code)
      await nodeWriteDisk.rename(from, to)
    }
  }
  return disk
}

const clock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('shell.files.writeFile', () => {
  it('writes a new file, and replaces one that is there, leaving nothing beside it', async () => {
    const dir = createTempModulesDir()
    const file = path.join(dir, 'Spending by Category 2026.csv')
    await writeFileAtomically(nodeWriteDisk, file, new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))
    expect([...fs.readFileSync(file)]).toEqual([0xef, 0xbb, 0xbf, 0x41])
    await writeFileAtomically(nodeWriteDisk, file, 'Café, 12.50\r\n')
    // Text is UTF-8, with no byte-order mark of its own
    expect(fs.readFileSync(file, 'utf8')).toBe('Café, 12.50\r\n')
    expect(fs.readdirSync(dir)).toEqual(['Spending by Category 2026.csv'])
  })

  it('is what the shell\'s files service writes with', async () => {
    const dir = createTempModulesDir()
    const files = createElectronFiles({
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }, shell: { trashItem: vi.fn() }, app: { getPath: () => dir },
      BrowserWindow: { getFocusedWindow: () => null, fromId: () => null }
    })
    await files.writeFile(path.join(dir, 'a.txt'), 'one')
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one')
  })

  it('retries the rename while another program holds the file, then writes it', async () => {
    const dir = createTempModulesDir()
    const file = path.join(dir, 'Report.pdf')
    fs.writeFileSync(file, 'last month')
    const disk = flakyDisk(3)
    await writeFileAtomically(disk, file, 'this month', clock())
    expect(disk.renames).toBe(4)
    expect(fs.readFileSync(file, 'utf8')).toBe('this month')
    expect(fs.existsSync(file + PARTIAL_SUFFIX)).toBe(false)
  })

  it('gives up after 10 s held, with the file as it was, no partial file, and a message saying what to do', async () => {
    const dir = createTempModulesDir()
    const file = path.join(dir, 'Report.csv')
    fs.writeFileSync(file, 'last month')
    const disk = flakyDisk(Infinity)
    const time = clock()
    const err = await writeFileAtomically(disk, file, 'this month', time).catch(e => e)
    expect(err.message).toBe('Report.csv couldn’t be saved: another program may have it open, or Tessera isn’t allowed to write in that folder. Close the file in any program that has it open, then try again.')
    expect(err.code).toBe('EBUSY')
    expect(time.now()).toBeGreaterThanOrEqual(10_000)
    expect(fs.readFileSync(file, 'utf8')).toBe('last month')
    expect(fs.readdirSync(dir)).toEqual(['Report.csv'])
  })

  it('doesn\'t retry what isn\'t a held file, and says why in words', async () => {
    const dir = createTempModulesDir()
    const missing = path.join(dir, 'gone', 'Report.csv')
    const err = await writeFileAtomically(nodeWriteDisk, missing, 'x').catch(e => e)
    expect(err.message).toBe('The folder for Report.csv no longer exists.')
    expect(err.cause).toMatchObject({ code: 'ENOENT' })
    expect(writeFailure(Object.assign(new Error('no space'), { code: 'ENOSPC' }), '/x/Report.pdf').message).toBe('There isn’t enough space on the disk to save Report.pdf.')
    expect(writeFailure(Object.assign(new Error('ro'), { code: 'EROFS' }), '/x/Report.pdf').message).toBe('Report.pdf can’t be saved there: the disk is read-only.')
    expect(writeFailure(new Error('odd'), '/x/Report.pdf').message).toBe('Report.pdf couldn’t be saved: odd')
  })

  it('removes the partial file when writing it fails half way', async () => {
    const dir = createTempModulesDir()
    const file = path.join(dir, 'Report.csv')
    const disk: WriteDisk = {
      ...nodeWriteDisk,
      writeFile: async (f, bytes) => { await nodeWriteDisk.writeFile(f, bytes.slice(0, 1)); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    }
    await expect(writeFileAtomically(disk, file, 'abc')).rejects.toThrow('There isn’t enough space on the disk to save Report.csv.')
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
