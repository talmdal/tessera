// The book's commands: File › New, Open, Close and Delete Book, and the sub-book commands views run.
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import {
  BOOK_COMMANDS, BOOK_CONTEXT_KEYS, BOOK_DIALOGS, BOOK_VIEWS, childrenOf, isBookError,
  type BookInfo, type NewBookArgs, type NewBookDialogInput, type NewBookDialogResult,
  type RenameSubBookDialogInput, type SubBookArgs
} from '@tessera/book-api'
import type { BookSessionImpl } from './BookSessionImpl'

const K = BOOK_CONTEXT_KEYS
const WRITABLE = `${K.isOpen} && !${K.isReadOnly}`

/** Shows a failure the user caused in a message box; anything else is also logged, as a bug. */
export function reportingFailures(context: Pick<PluginContext, 'logger'>, prompts: ShellPrompts) {
  return async <T>(doing: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (err) {
      if (!isBookError(err)) context.logger.error(`[book] ${doing} failed`, err)
      await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }
}

/** Shows one of the book's views, when the layout is there to do it. */
export function revealer(context: Pick<PluginContext, 'commands' | 'logger'>) {
  return async (viewId: string) => {
    if (!context.commands.has('shell.layout.reveal')) return
    await context.commands.execute('shell.layout.reveal', viewId)
      .catch(err => context.logger.warn(`[book] Could not show ${viewId}: ${err instanceof Error ? err.message : String(err)}`))
  }
}

const subBookId = (args: unknown) => {
  const id = (args as Partial<SubBookArgs> | undefined)?.id
  if (typeof id !== 'string' || id === '') throw new Error('This command needs { id } of a sub-book')
  return id
}

export function registerCommands(context: PluginContext, session: BookSessionImpl, prompts: ShellPrompts): Disposable[] {
  const attempt = reportingFailures(context, prompts)
  const reveal = revealer(context)

  /** Creates a book file, then shows its tree (a navigator that replaces the panel shows its own). */
  const createFile = async (name?: string) => {
    const created = await attempt('create the book', () => session.create(undefined, name === undefined ? {} : { name }))
    if (created && !session.hasNavigator) await reveal(BOOK_VIEWS.tree)
    return created
  }

  return [
    context.commands.register(BOOK_COMMANDS.new, async (args?: unknown): Promise<NewBookDialogResult | BookInfo | undefined> => {
      // With nothing open there is no parent to choose: straight to the new file
      if (!session.current) return createFile()

      const requested = (args as NewBookArgs | undefined)?.parentId
      const tree = await session.tree()
      const parentId = requested === undefined || requested === null || tree.subBooks.some(s => s.id === requested) ? requested : undefined
      const input: NewBookDialogInput = { tree, ...(parentId !== undefined && { parentId }) }
      const result = await prompts.show<NewBookDialogResult>(BOOK_DIALOGS.newBook, input)
      if (result?.kind === 'file') return createFile(result.name)
      return result      // a sub-book, created by the dialog itself so it could show a duplicate name; or cancelled
    }, { enablement: `!${K.isReadOnly}` }),

    context.commands.register(BOOK_COMMANDS.open, () => attempt('open the book', () => session.open())),

    context.commands.register(BOOK_COMMANDS.close, async () => {
      await session.close()
      await reveal(BOOK_VIEWS.start)
    }, { enablement: K.isOpen }),

    context.commands.register(BOOK_COMMANDS.delete, async () => {
      const deleted = await attempt('delete the book', () => session.delete())
      if (deleted) await reveal(BOOK_VIEWS.start)
      return deleted
    }, { enablement: WRITABLE }),

    context.commands.register(BOOK_COMMANDS.renameSubBook, async (args?: unknown) => {
      const id = subBookId(args)
      const subBook = (await session.tree()).subBooks.find(s => s.id === id)
      if (!subBook) return undefined
      const input: RenameSubBookDialogInput = { id, name: subBook.name, rev: subBook.rev }
      return prompts.show<{ id: string }>(BOOK_DIALOGS.renameSubBook, input)
    }, { enablement: WRITABLE }),

    context.commands.register(BOOK_COMMANDS.deleteSubBook, async (args?: unknown) => {
      const id = subBookId(args)
      const tree = await session.tree()
      const subBook = tree.subBooks.find(s => s.id === id)
      if (!subBook) return false

      const parent = subBook.parentId === null ? tree.book.name : tree.subBooks.find(s => s.id === subBook.parentId)?.name ?? tree.book.name
      const children = childrenOf(tree.subBooks, id).length
      const contents = [
        ...(children > 0 ? [`${children} sub-book${children === 1 ? '' : 's'}`] : []),
        ...await session.describeContents(id)
      ]
      const confirmed = await prompts.confirm({
        message: `Delete sub-book “${subBook.name}”?`,
        detail: contents.length === 0
          ? 'It is empty.'
          : `Its ${joinList(contents)} will move to “${parent}”. Nothing in it is deleted.`,
        confirmLabel: 'Delete'
      })
      if (!confirmed) return false
      return (await attempt('delete the sub-book', async () => { await session.deleteSubBook(id); return true })) ?? false
    }, { enablement: WRITABLE })
  ]
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
