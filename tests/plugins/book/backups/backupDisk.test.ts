// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_NAME_ATTEMPTS, nodeBackupDisk } from '../../../../plugins/book/src/privileged/backups/BackupDisk'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-backups-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const disk = nodeBackupDisk()
const named = (base: string) => (attempt: number) => `${base}${attempt > 1 ? ` (${attempt})` : ''}.tessera-backup`
const writing = (text: string) => async (out: NodeJS.WritableStream) => {
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    out.end(text, () => resolve())
  })
}

describe('creating a backup file', () => {
  it('writes it whole under its final name, leaving nothing else behind', async () => {
    const folder = tempDir()
    const file = await disk.create(folder, named('Home'), writing('the whole backup'))
    expect(file).toBe(path.join(folder, 'Home.tessera-backup'))
    expect(fs.readFileSync(file, 'utf8')).toBe('the whole backup')
    expect(fs.readdirSync(folder)).toEqual(['Home.tessera-backup'])
  })

  it('never overwrites: a taken name gets the next one', async () => {
    const folder = tempDir()
    await disk.create(folder, named('Home'), writing('first'))
    const second = await disk.create(folder, named('Home'), writing('second'))
    const third = await disk.create(folder, named('Home'), writing('third'))
    expect(path.basename(second)).toBe('Home (2).tessera-backup')
    expect(path.basename(third)).toBe('Home (3).tessera-backup')
    expect(fs.readFileSync(path.join(folder, 'Home.tessera-backup'), 'utf8')).toBe('first')
  })

  it('writes under a .partial name until it is complete', async () => {
    const folder = tempDir()
    let seen: string[] = []
    await disk.create(folder, named('Home'), async out => {
      await new Promise<void>(resolve => out.write('half', () => resolve()))
      seen = fs.readdirSync(folder)
      await writing(' and the rest')(out)
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^Home\.tessera-backup\.[0-9a-f]{8}\.partial$/)
  })

  it('leaves nothing at all when writing fails', async () => {
    const folder = tempDir()
    const failing = async (out: NodeJS.WritableStream) => {
      await new Promise<void>(resolve => out.write('some of it', () => resolve()))
      throw new Error('disk full')
    }
    await expect(disk.create(folder, named('Home'), failing)).rejects.toThrow('disk full')
    expect(fs.readdirSync(folder)).toEqual([])
  })

  it('gives up, leaving nothing, when every name is taken', async () => {
    const folder = tempDir()
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) fs.writeFileSync(path.join(folder, named('Home')(attempt)), 'x')
    await expect(disk.create(folder, named('Home'), writing('one too many'))).rejects.toThrow('is taken')
    expect(fs.readdirSync(folder).filter(f => f.endsWith('.partial'))).toEqual([])
  })

  it('fails for a folder that does not exist, rather than creating it', async () => {
    const missing = path.join(tempDir(), 'unplugged drive')
    await expect(disk.create(missing, named('Home'), writing('x'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fs.existsSync(missing)).toBe(false)
  })
})

describe('the backup folder', () => {
  it('lists backups only: not partial files, other files or folders', async () => {
    const folder = tempDir()
    fs.writeFileSync(path.join(folder, 'B.tessera-backup'), '12345')
    fs.writeFileSync(path.join(folder, 'a.TESSERA-BACKUP'), '1')
    fs.writeFileSync(path.join(folder, 'C.tessera-backup.0badf00d.partial'), 'half')
    fs.writeFileSync(path.join(folder, 'Home.tessera'), 'a book')
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x')
    fs.mkdirSync(path.join(folder, 'old.tessera-backup'))

    const listed = await disk.list(folder)
    expect(listed.map(f => path.basename(f.file))).toEqual(['B.tessera-backup', 'a.TESSERA-BACKUP'])
    expect(listed[0]).toMatchObject({ size: 5, modifiedAt: expect.any(Date) })
    expect((await disk.partials(folder)).map(f => path.basename(f.file))).toEqual(['C.tessera-backup.0badf00d.partial'])
  })

  it('says whether a folder is there, and makes one with its parents', async () => {
    const root = tempDir()
    const nested = path.join(root, 'Documents', 'Tessera Backups')
    expect(await disk.folderExists(nested)).toBe(false)
    await disk.makeFolder(nested)
    expect(await disk.folderExists(nested)).toBe(true)
    fs.writeFileSync(path.join(root, 'a file'), '')
    expect(await disk.folderExists(path.join(root, 'a file'))).toBe(false)
  })

  it('removes a file, and does not mind one already gone', async () => {
    const folder = tempDir()
    const file = path.join(folder, 'Old.tessera-backup')
    fs.writeFileSync(file, 'x')
    await disk.remove(file)
    await disk.remove(file)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('opens a file as a stream of its bytes', async () => {
    const folder = tempDir()
    const file = await disk.create(folder, named('Home'), writing('bytes on disk'))
    const chunks: Buffer[] = []
    for await (const chunk of disk.open(file)) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('bytes on disk')
  })
})
