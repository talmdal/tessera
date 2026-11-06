import { describe, expect, it } from 'vitest'
import { resolveDialogs } from '../../shared/dialogs/resolveDialogs'

const entry = (pluginId: string) => pluginId === 'nor' ? undefined : `tessera-plugin://${pluginId}/remoteEntry.js`
const from = (contributor: string, impl: unknown) => ({ contributor, impl })

describe('resolveDialogs', () => {
  it("resolves a plugin's dialog with its remote entry and a default size", () => {
    const { dialogs, diagnostics } = resolveDialogs([
      from('ledger', { id: 'ledger.dialog.new', title: 'New Ledger', module: './NewLedgerDialog' }),
      from('ledger', { id: 'ledger.dialog.rename', title: 'Rename', module: './RenameDialog', size: 'xs' })
    ], entry)

    expect(diagnostics).toEqual([])
    expect(dialogs).toEqual([
      { id: 'ledger.dialog.new', title: 'New Ledger', module: './NewLedgerDialog', size: 'sm', pluginId: 'ledger', remoteEntry: 'tessera-plugin://ledger/remoteEntry.js' },
      { id: 'ledger.dialog.rename', title: 'Rename', module: './RenameDialog', size: 'xs', pluginId: 'ledger', remoteEntry: 'tessera-plugin://ledger/remoteEntry.js' }
    ])
  })

  it("needs no remote entry for the shell's own dialogs, which are built into the renderer", () => {
    const { dialogs, diagnostics } = resolveDialogs([from('shell', { id: 'shell.prompt', title: 'Tessera', module: './Prompt' })], () => undefined)
    expect(diagnostics).toEqual([])
    expect(dialogs).toEqual([{ id: 'shell.prompt', title: 'Tessera', module: './Prompt', size: 'sm', pluginId: 'shell' }])
  })

  it('refuses a dialog id outside its contributor, so nobody can take over another plugin\'s dialog', () => {
    const { dialogs, diagnostics } = resolveDialogs([
      from('evil', { id: 'ledger.dialog.new', title: 'Gotcha', module: './X' }),
      from('evil', { id: 'evilish', title: 'No dot', module: './X' })
    ], entry)
    expect(dialogs).toEqual([])
    expect(diagnostics).toEqual([
      'Dialog "ledger.dialog.new" ignored: its id must start with "evil."',
      'Dialog "evilish" ignored: its id must start with "evil."'
    ])
  })

  it('reports malformed contributions and keeps the valid ones', () => {
    const { dialogs, diagnostics } = resolveDialogs([
      from('p', null),
      from('p', { title: 'x', module: './X' }),
      from('p', { id: 'p.a', module: './X' }),
      from('p', { id: 'p.b', title: '  ', module: './X' }),
      from('p', { id: 'p.c', title: 'C', module: 'X' }),
      from('p', { id: 'p.d', title: 'D', module: './D', size: 'huge' }),
      from('nor', { id: 'nor.e', title: 'E', module: './E' }),
      from('p', { id: 'p.ok', title: 'OK', module: './Ok' }),
      from('p', { id: 'p.ok', title: 'Again', module: './Again' })
    ], entry)

    expect(dialogs.map(d => d.id)).toEqual(['p.ok'])
    expect(dialogs[0].title).toBe('OK')
    expect(diagnostics).toEqual([
      'Dialog contribution is not an object',
      'Dialog contribution is missing an id',
      'Dialog "p.a" is missing a title',
      'Dialog "p.b" is missing a title',
      'Dialog "p.c" must name an exposed module like "./MyDialog"',
      'Dialog "p.d" has an invalid size; use one of xs, sm, md, lg',
      'Dialog "nor.e" ignored: "nor" has no renderer entry',
      'Duplicate dialog id "p.ok" ignored'
    ])
  })
})
