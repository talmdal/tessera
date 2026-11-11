// npm run sample:archive -- [folder] [--replace]     (npm passes arguments on after the --)
//
// Makes a sample ledger and its archive file, for trying archives by hand: "Household.tessera", archived before
// 1 January 2026, and "Archives/Household (archive before 2026-01-01).tesserabkp". The folder defaults to
// samples/archive (not kept in git). See scripts/sample-archive/household.ts for what is in them.
//
// The ledger and accounts plugins' code is bundled with esbuild, with the @tessera/* packages aliased as the plugin
// build aliases them, and run here with Node (which must have node:sqlite: Node 22.5 or later).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const repo = process.cwd()
const args = process.argv.slice(2)
const replace = args.includes('--replace')
const folder = path.resolve(args.find(arg => !arg.startsWith('--')) ?? path.join(repo, 'samples', 'archive'))

const PACKAGES: Record<string, string> = {
  '@tessera/types': 'tessera-types/index.ts',
  '@tessera/storage-kit': 'packages/storage-kit/index.ts',
  '@tessera/ledger-api': 'packages/ledger-api/index.ts',
  '@tessera/accounts-api': 'packages/accounts-api/index.ts',
  '@tessera/import-api': 'packages/import-api/index.ts'
}

const bundle = path.join(os.tmpdir(), `tessera-sample-archive-${process.pid}.mjs`)
await esbuild.build({
  entryPoints: [path.join(repo, 'scripts', 'sample-archive', 'household.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['node:*'],
  alias: Object.fromEntries(Object.entries(PACKAGES).map(([name, file]) => [name, path.join(repo, file)])),
  logLevel: 'warning'
})

const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString()} KB`

try {
  const { makeSampleArchive } = await import(pathToFileURL(bundle).href)
  const made = await makeSampleArchive(folder, { replace, log: (line: string) => console.log(line) })
  console.log([
    '',
    `The ledger:       ${made.ledger}`,
    `Its archive file: ${made.archive}`,
    '',
    `Archived before ${made.outcome.before}: ${made.outcome.summaries.join('; ')}.`,
    ...(made.outcome.compaction && 'after' in made.outcome.compaction
      ? [`Compacted: the ledger's file went from ${kb(made.outcome.compaction.before)} to ${kb(made.outcome.compaction.after)}.`]
      : made.outcome.compaction ? [`Not compacted: ${made.outcome.compaction.problem}`] : []),
    ...(made.said.length > 0 ? ['', 'The Archive dialog would have said:', ...made.said.map((line: string) => `  ${line}`)] : []),
    '',
    'To try it, in npm run dev:',
    '  File › Open Ledger… and choose the archive file (the "Tessera archive" filter): it opens read-only.',
    '  File › Open Ledger… and choose the ledger: the history before 2026 is gone, and every balance is as it was.',
    '  Each register starts with its opening balance on 1 Jan 2026; its tooltip says what was archived.',
    '  File › Archive Ledger… on the ledger, before 1 Oct 2026: archives what was reconciled this year. Its archive',
    '  file goes in your backup folder\'s Archives folder.',
    '  File › Restore Ledger…, Browse…, and choose the archive file: restore it in place of Household (undoing the',
    '  archive), or as a new ledger. To have Restore list it without Browse…, copy the Archives folder into your',
    '  backup folder (Documents › Tessera Backups, unless the Backups page says otherwise).'
  ].join('\n'))
} finally {
  fs.rmSync(bundle, { force: true })
}
