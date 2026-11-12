// npm run anonymise -- <files…> [options]     (npm passes arguments on after the --)
//
// Takes the personal data out of real statement files, keeping their dialect, so they can be added to the tests.
// See docs/import-formats-design.md, "Anonymising real statement files". OFX, QFX, QBO, CSV and QIF.
//
//   --out <folder>        where to write (default: beside each file), as <name>.anon.<ext>
//   --keep-amounts        leave amounts as they are (default: changed, with balances that still add up)
//   --shift-dates <weeks> move every date by whole weeks (default: dates kept)
//   --hide-institution    replace the bank's name and ids too (default: kept)
//   --keep-words <file>   words to leave alone, such as well-known merchants, one per line
//   --map <file>          keep the mapping, to anonymise next month's file the same way (never inside the repository)
//   --allow-like <example> a finding to keep as it is, shaped like the example: letters where it has letters, digits
//                         where it has digits ('--allow-like AB12345678'); no regular expression, nothing to quote
//   --allow <regex>       a finding to keep as it is, as a regular expression (quoted for your shell)
//   --allow-file <file>   findings to keep as they are, one per line: an example ('like AB12345678') or a regex
//                         Each may be given more than once. What is allowed is written as it is: allow only what isn't
//                         personal (a bank's public phone number)
//   --check               scan files without changing them; exit 1 if anything is found
//
// The anonymiser's modules are bundled with esbuild, with the @tessera/* packages aliased as the plugin build aliases
// them, and run here with Node, as sample-archive.mts does.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const repo = process.cwd()
/**
 * Where the user ran the command. npm runs scripts from the project's root, whatever folder it was started in, and says
 * where that was in INIT_CWD: relative paths are the user's, so they are resolved from there.
 */
const here = process.env.INIT_CWD ?? process.cwd()
const resolve = (file: string) => path.resolve(here, file)

const PACKAGES: Record<string, string> = {
  '@tessera/types': 'tessera-types/index.ts',
  '@tessera/ledger-api': 'packages/ledger-api/index.ts',
  '@tessera/accounts-api': 'packages/accounts-api/index.ts',
  '@tessera/import-api': 'packages/import-api/index.ts'
}

function usage(problem?: string): never {
  if (problem) console.error(`${problem}\n`)
  console.error('Usage: npm run anonymise -- <files…> [--out <folder>] [--keep-amounts] [--shift-dates <weeks>] [--hide-institution]')
  console.error('                           [--keep-words <file>] [--map <file>] [--allow-like <example>]… [--allow <regex>]…')
  console.error('                           [--allow-file <file>] [--check]')
  process.exit(2)
}

// The arguments
const args = process.argv.slice(2)
const files: string[] = []
const options = { keepAmounts: false, hideInstitution: false, check: false, shiftWeeks: 0, allow: [] as RegExp[], keepWords: [] as string[] }
/** `--allow-like` examples, made rules once the tool is loaded. */
const likes: string[] = []
let out: string | undefined
let mapPath: string | undefined
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const value = () => args[++i] ?? usage(`${arg} needs a value.`)
  if (arg === '--out') out = resolve(value())
  else if (arg === '--keep-amounts') options.keepAmounts = true
  else if (arg === '--hide-institution') options.hideInstitution = true
  else if (arg === '--keep-institution') options.hideInstitution = false
  else if (arg === '--check') options.check = true
  else if (arg === '--shift-dates') {
    options.shiftWeeks = Number(value())
    if (!Number.isInteger(options.shiftWeeks)) usage('--shift-dates takes a whole number of weeks.')
  } else if (arg === '--keep-words') options.keepWords = fs.readFileSync(resolve(value()), 'utf8').split(/\r?\n/).map(w => w.trim()).filter(Boolean)
  else if (arg === '--map') mapPath = resolve(value())
  else if (arg === '--allow') {
    const pattern = value()
    try { options.allow.push(new RegExp(pattern, 'i')) } catch { usage(`--allow ${pattern} isn't a regular expression. To allow values shaped like an example, use --allow-like.`) }
  } else if (arg === '--allow-like') likes.push(value())
  else if (arg === '--allow-file') {
    const file = resolve(value())
    if (!fs.existsSync(file)) usage(`--allow-file ${file} doesn't exist.`)
    for (const [n, raw] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const like = /^like\s+(.+)$/i.exec(line)
      if (like) { likes.push(like[1]); continue }
      try { options.allow.push(new RegExp(line, 'i')) } catch { usage(`${file}, line ${n + 1}: “${line}” isn't a regular expression (start it with “like ” for an example).`) }
    }
  } else if (arg.startsWith('--')) usage(`${arg} isn't an option.`)
  else files.push(resolve(arg))
}
if (files.length === 0) usage('Give the files to anonymise.')

/** The repository the tool runs in: the folder with .git, looking up from here. The mapping must never go in it. */
function repository(): string {
  for (let dir = repo; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    if (path.dirname(dir) === dir) return repo
  }
}
const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
if (mapPath && (inside(mapPath, repository()) || inside(mapPath, repo))) {
  usage(`The mapping holds the original values, so it can't be kept inside the repository (${repository()}). Give a path outside it.`)
}

/** How many single-character edits turn one name into the other. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

/** A file that isn't there: the names in its folder closest to it, as a typo ('checking' for 'chequing') is likely. */
function missing(file: string): never {
  const folder = path.dirname(file)
  if (!fs.existsSync(folder)) usage(`${file} doesn't exist: there is no folder ${folder}.`)
  const wanted = path.basename(file).toLowerCase()
  const close = fs.readdirSync(folder)
    .map(name => ({ name, apart: distance(name.toLowerCase(), wanted) }))
    .filter(c => c.apart <= Math.max(2, Math.floor(wanted.length / 5)))
    .sort((a, b) => a.apart - b.apart || a.name.localeCompare(b.name))
    .slice(0, 3)
  usage(`${file} doesn't exist.${close.length > 0 ? ` Did you mean ${close.map(c => `“${c.name}”`).join(' or ')}?` : ''}`)
}
for (const file of files) if (!fs.existsSync(file)) missing(file)

const bundle = path.join(os.tmpdir(), `tessera-anonymise-${process.pid}.mjs`)
await esbuild.build({
  entryPoints: [path.join(repo, 'scripts', 'anonymise', 'index.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['node:*'],
  alias: Object.fromEntries(Object.entries(PACKAGES).map(([name, file]) => [name, path.join(repo, file)])),
  logLevel: 'warning'
})

try {
  const tool = await import(pathToFileURL(bundle).href)
  for (const example of likes) options.allow.push(tool.likeRule(example))
  const inputs = files.map(file => ({ name: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) }))
  type Shown = { kind: string, line: number, masked: string, shape: string, where?: string }
  const show = (f: Shown) => `    line ${f.line}${f.where ? `, ${f.where}` : ''}: ${f.kind}: ${f.masked}  (shaped like ${f.shape})`
  /** How to allow what was found, by its shape: an example the user can type as it is, in any shell. */
  const howToAllow = (findings: Shown[]) => {
    const shapes = [...new Set(findings.map(f => f.shape))]
    console.log('    If one is harmless (a bank\'s public phone number, say), run again allowing its shape; it is then written')
    console.log('    as it is, so allow only what isn\'t personal:')
    console.log(`      ${shapes.map(s => `--allow-like ${s}`).join(' ')}`)
    console.log('    Or list them in a file, one per line (“like AA99999999”), and give --allow-file <file>.')
  }
  let problems = 0

  if (options.check) {
    for (const result of tool.check(inputs, { allow: options.allow })) {
      if (result.error) { console.log(`${result.name}: ${result.error}`); problems++; continue }
      if (result.findings.length === 0) { console.log(`${result.name}: nothing looks personal.`); continue }
      problems++
      console.log(`${result.name}: ${result.findings.length} ${result.findings.length === 1 ? 'thing looks' : 'things look'} personal:`)
      for (const finding of result.findings) console.log(show(finding))
      howToAllow(result.findings)
    }
  } else {
    const mapping = mapPath && fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : undefined
    const { outputs, mapping: updated } = tool.anonymise(inputs, { ...options, ...(mapping && { mapping }) })
    outputs.forEach((output: { name: string, outputName: string, text: string, sidecar?: object, findings: Shown[], allowed?: Shown[], counts: object, notes?: string[], error?: string }, i: number) => {
      if (output.error) { console.log(output.error); problems++; return }
      const target = path.join(out ?? path.dirname(files[i]), output.outputName)
      if (output.findings.length > 0) {
        problems++
        console.log(`${output.name}: not written. After anonymising, ${output.findings.length === 1 ? 'this still looks' : 'these still look'} personal:`)
        for (const finding of output.findings) console.log(show(finding))
        howToAllow(output.findings)
        return
      }
      if (fs.existsSync(target)) { console.log(`${output.name}: not written, as ${target} exists. Move it away first.`); problems++; return }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, output.text, 'utf8')
      if (output.sidecar) fs.writeFileSync(`${target}.meta.json`, `${JSON.stringify(output.sidecar, null, 2)}\n`, 'utf8')
      const how = (sidecar: { encoding: string, bom: boolean, lineEnd: string }) => [
        ...(sidecar.encoding !== 'utf-8' ? [sidecar.encoding] : []), ...(sidecar.bom ? ['a byte-order mark'] : []),
        ...(sidecar.lineEnd !== '\n' ? [`${sidecar.lineEnd === '\r\n' ? 'CRLF' : 'CR'} line ends`] : [])
      ].join(', ')
      console.log(`${output.name} → ${target}${output.sidecar ? ` (and its .meta.json, to rebuild the original's ${how(output.sidecar as { encoding: string, bom: boolean, lineEnd: string })})` : ''}`)
      console.log(`    ${tool.describeCounts(output.counts)}.`)
      for (const note of output.notes ?? []) console.log(`    Note: ${note}`)
      if (output.allowed?.length) {
        console.log(`    Written as ${output.allowed.length === 1 ? 'it was, as allowed' : 'they were, as allowed'}: read ${output.allowed.length === 1 ? 'it' : 'them'} before committing the file:`)
        for (const finding of output.allowed) console.log(`  ${show(finding)}`)
      }
    })
    if (mapPath) {
      fs.mkdirSync(path.dirname(mapPath), { recursive: true })
      fs.writeFileSync(mapPath, JSON.stringify(updated), 'utf8')
      console.log(`\nThe mapping is in ${mapPath}. It holds the original values: keep it private, and never commit it.`)
    }
    console.log('\nRead each file before committing it: the scan is a safety net, not a guarantee.')
  }
  process.exitCode = problems > 0 ? 1 : 0
} finally {
  fs.rmSync(bundle, { force: true })
}
