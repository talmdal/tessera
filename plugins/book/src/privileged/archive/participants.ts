// Who takes part in archiving, and in what order. See docs/archive-design.md, "Participants".
//
// Order decides only when each participant runs, never what it removes: every survey publishes the ids it is
// removing, and every prune is handed all of them. `accounts` runs last because it makes the opening-balance
// adjustment and checks that no balance moved, which must happen after everything else has had its say.
import type { Disposable } from '@tessera/types'
import { BookError, type ArchiveParticipant } from '@tessera/book-api'

export interface RegisteredParticipant {
  contributor: string
  participant: ArchiveParticipant
  /** Contributors this one must run before. */
  before: readonly string[]
}

/** The archive participants of the open application, in a stable, declared order. */
export class ArchiveParticipants {
  private readonly entries = new Map<string, RegisteredParticipant>()

  add(contributor: string, participant: ArchiveParticipant, options: { before?: string[] } = {}): Disposable {
    if (typeof contributor !== 'string' || contributor === '') throw new Error('An archive participant needs a contributor id')
    if (typeof participant?.survey !== 'function' || typeof participant.prune !== 'function') {
      throw new Error(`The archive participant of "${contributor}" needs survey and prune`)
    }
    const before = options.before ?? []
    if (!Array.isArray(before) || before.some(id => typeof id !== 'string' || id === '')) {
      throw new Error(`The archive participant of "${contributor}" has an invalid "before"`)
    }
    if (before.includes(contributor)) throw new Error(`The archive participant of "${contributor}" can't run before itself`)
    if (this.entries.has(contributor)) throw new Error(`"${contributor}" already takes part in archiving`)

    const entry: RegisteredParticipant = { contributor, participant, before: [...before] }
    this.entries.set(contributor, entry)
    return { dispose: () => { if (this.entries.get(contributor) === entry) this.entries.delete(contributor) } }
  }

  get size() { return this.entries.size }

  has(contributor: string) { return this.entries.has(contributor) }

  /**
   * Every participant, each after the ones it must follow. A `before` naming a contributor that isn't registered
   * is ignored, so a plugin that isn't installed never stops archiving. Participants with nothing between them
   * keep the order they registered in, which the activation plan makes deterministic.
   */
  ordered(): RegisteredParticipant[] {
    const entries = [...this.entries.values()]
    // `a.before` names who must come after a; build the other direction, "who must come before me"
    const after = new Map<string, Set<string>>(entries.map(entry => [entry.contributor, new Set<string>()]))
    for (const entry of entries) {
      for (const later of entry.before) {
        if (after.has(later)) after.get(later)!.add(entry.contributor)
      }
    }

    const done = new Set<string>()
    const sorted: RegisteredParticipant[] = []
    while (sorted.length < entries.length) {
      // The first that registered whose predecessors have all run: registration order is the tie-break
      const next = entries.find(entry => !done.has(entry.contributor) && [...after.get(entry.contributor)!].every(id => done.has(id)))
      if (!next) {
        const stuck = entries.filter(entry => !done.has(entry.contributor)).map(entry => entry.contributor)
        throw new BookError('INVALID', `These plugins can’t agree on who archives first: ${stuck.join(', ')}.`)
      }
      done.add(next.contributor)
      sorted.push(next)
    }
    return sorted
  }
}
