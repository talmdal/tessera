// Saving an export (docs/export-design.md, "Writing the file safely"): under a temporary name, then renamed over the
// file, retrying while another program holds it; the file chosen is the whole new file, or untouched.
import { describe, expect, it } from 'vitest'
import { PARTIAL_SUFFIX, saveFile } from '../../../plugins/export/src/privileged/files'
import { memoryExportDisk } from './harness'

const bytes = (text: string) => new TextEncoder().encode(text)
/** A clock that moves on by each wait, so a retry budget runs out without waiting. */
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('saving an export', () => {
  it('writes a temporary file beside it, then renames it over the file, replacing what was there', async () => {
    const store = memoryExportDisk()
    store.files.set('/x/Export.csv', bytes('last month'))
    await saveFile(store.disk, '/x/Export.csv', bytes('this month'), clock())
    expect(store.disk.writeFile).toHaveBeenCalledWith(`/x/Export.csv${PARTIAL_SUFFIX}`, expect.anything())
    expect([...store.files.keys()]).toEqual(['/x/Export.csv'])
    expect(store.text('/x/Export.csv')).toBe('this month')
  })

  it('tries the rename again while another program holds the file', async () => {
    const store = memoryExportDisk()
    store.fail.rename.push('EBUSY', 'EPERM')
    await saveFile(store.disk, '/x/Export.csv', bytes('ok'), clock())
    expect(store.disk.rename).toHaveBeenCalledTimes(3)
    expect(store.text('/x/Export.csv')).toBe('ok')
  })

  it('gives up after the budget, removes the temporary file, leaves the file as it was, and says why', async () => {
    const store = memoryExportDisk()
    store.files.set('/x/Export.csv', bytes('last month'))
    store.fail.rename.push(...Array(100).fill('EBUSY'))
    await expect(saveFile(store.disk, '/x/Export.csv', bytes('new'), { ...clock(), budgetMs: 2000 })).rejects.toMatchObject({
      code: 'WRITE_FAILED', message: expect.stringContaining('Export.csv couldn’t be saved: another program may have it open')
    })
    expect([...store.files.keys()]).toEqual(['/x/Export.csv'])
    expect(store.text('/x/Export.csv')).toBe('last month')
  })

  it('says the disk is full, or the folder has gone, without retrying', async () => {
    const store = memoryExportDisk()
    store.fail.write.push('ENOSPC')
    await expect(saveFile(store.disk, '/x/Export.csv', bytes('x'), clock())).rejects.toMatchObject({ message: 'There isn’t enough space on the disk to save Export.csv.' })
    store.fail.rename.push('ENOENT')
    await expect(saveFile(store.disk, '/gone/Export.csv', bytes('x'), clock())).rejects.toMatchObject({ message: 'The folder for Export.csv no longer exists.' })
    expect(store.disk.rename).toHaveBeenCalledTimes(1)
    expect(store.files.size).toBe(0)
  })
})
