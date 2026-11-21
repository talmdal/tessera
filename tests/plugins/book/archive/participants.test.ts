// @vitest-environment node
// Who takes part in archiving, and in what order. See docs/archive-design.md, "Participants".
import { describe, expect, it, vi } from 'vitest'
import type { ArchiveParticipant } from '@tessera/book-api'
import { ArchiveParticipants } from '../../../../plugins/book/src/privileged/archive/participants'
import { setupSession } from '../harness'

const participant = (): ArchiveParticipant => ({
  survey: vi.fn(async () => ({ describe: 'nothing', documents: 0, warnings: [] })),
  prune: vi.fn(async () => ({ documents: 0 }))
})

const names = (registry: ArchiveParticipants) => registry.ordered().map(entry => entry.contributor)

describe('registering an archive participant', () => {
  it('takes one with survey and prune, and gives it back in order', () => {
    const registry = new ArchiveParticipants()
    registry.add('accounts', participant())
    expect(names(registry)).toEqual(['accounts'])
    expect(registry.has('accounts')).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('refuses one that can’t do the job', () => {
    const registry = new ArchiveParticipants()
    expect(() => registry.add('accounts', { survey: vi.fn() } as never)).toThrow(/needs survey and prune/)
    expect(() => registry.add('', participant())).toThrow(/needs a contributor id/)
    expect(() => registry.add('accounts', participant(), { before: ['accounts'] })).toThrow(/can't run before itself/)
    expect(() => registry.add('accounts', participant(), { before: [''] as string[] })).toThrow(/invalid "before"/)
    expect(registry.size).toBe(0)
  })

  it('refuses a second registration by the same plugin', () => {
    const registry = new ArchiveParticipants()
    registry.add('accounts', participant())
    expect(() => registry.add('accounts', participant())).toThrow(/already takes part/)
  })

  it('stops taking part when disposed, and lets the plugin register again', () => {
    const registry = new ArchiveParticipants()
    const registration = registry.add('accounts', participant())
    registration.dispose()
    expect(names(registry)).toEqual([])
    expect(() => registry.add('accounts', participant())).not.toThrow()
  })
})

describe('the order participants run in', () => {
  it('puts a participant before the ones it declares, whenever it registered', () => {
    const registry = new ArchiveParticipants()
    registry.add('accounts', participant())
    registry.add('recurring', participant(), { before: ['accounts'] })
    registry.add('exchange', participant(), { before: ['accounts'] })

    expect(names(registry)).toEqual(['recurring', 'exchange', 'accounts'])
  })

  it('keeps registration order between participants with nothing to say about each other', () => {
    const registry = new ArchiveParticipants()
    registry.add('exchange', participant())
    registry.add('recurring', participant())
    expect(names(registry)).toEqual(['exchange', 'recurring'])
  })

  it('follows a chain of orderings', () => {
    const registry = new ArchiveParticipants()
    registry.add('accounts', participant())
    registry.add('recurring', participant(), { before: ['accounts'] })
    registry.add('exchange', participant(), { before: ['recurring'] })

    expect(names(registry)).toEqual(['exchange', 'recurring', 'accounts'])
  })

  it('ignores an ordering against a plugin that isn’t installed', () => {
    const registry = new ArchiveParticipants()
    registry.add('recurring', participant(), { before: ['accounts'] })
    expect(names(registry)).toEqual(['recurring'])
  })

  it('refuses to guess when two participants each insist on going first', () => {
    const registry = new ArchiveParticipants()
    registry.add('accounts', participant(), { before: ['recurring'] })
    registry.add('recurring', participant(), { before: ['accounts'] })

    expect(() => registry.ordered()).toThrow(/can’t agree on who archives first: accounts, recurring/)
  })
})

describe('the session’s registration', () => {
  it('is on the published contract, so any plugin can take part', () => {
    const { session } = setupSession()
    const registration = session.participateInArchive('recurring', participant(), { before: ['accounts'] })

    expect(session.archiveParticipants.ordered().map(e => e.contributor)).toEqual(['recurring'])
    registration.dispose()
    expect(session.archiveParticipants.size).toBe(0)
  })
})
