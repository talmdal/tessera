import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOOK_CHANNELS, BOOK_COMMANDS, BOOK_EVENTS, type BookTree as Tree, type RecentBook, type SubBook
} from '@tessera/book-api'
import BookTree from '../../../../plugins/book/src/renderer/BookTree'
import NewBookDialog from '../../../../plugins/book/src/renderer/NewBookDialog'
import RenameDialog from '../../../../plugins/book/src/renderer/RenameDialog'
import StartView from '../../../../plugins/book/src/renderer/StartView'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const EXECUTE = 'shell:commands.execute'
const sub = (id: string, parentId: string | null, name: string, order = 0): SubBook => ({ id, parentId, name, order, rev: 1 })
const TREE: Tree = {
  book: { path: '/l/Home.tessera', name: 'Home', readOnly: false },
  subBooks: [sub('p', null, 'Personal', 0), sub('b', null, 'Business', 1), sub('r', 'p', 'Rentals')]
}

/** A fake `window.api`: `answers` by channel, and for commands, by command id. */
function bridge(answers: Record<string, (data: any) => unknown> = {}, commands: Record<string, (args: unknown[]) => unknown> = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    if (channel === EXECUTE) return commands[data.id]?.(data.args ?? [])
    const answer = answers[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  const executed = () => calls(EXECUTE) as { id: string, args: unknown[] }[]
  return { ...remote, calls, executed }
}

afterEach(() => { delete (window as any).api })

describe('the start view', () => {
  const recent: RecentBook[] = [
    { path: '/l/Home.tessera', name: 'Home', openedAt: '2026-11-01T10:00:00Z', exists: true },
    { path: '/l/Old.tessera', name: 'Old', openedAt: '2026-10-01T10:00:00Z', exists: false }
  ]
  const setup = (state: object = { isOpen: false }, open: (data: any) => unknown = () => ({ ok: true, value: undefined })) => {
    const b = bridge({
      [BOOK_CHANNELS.state]: () => state,
      [BOOK_CHANNELS.recent]: () => recent,
      [BOOK_CHANNELS.open]: open,
      [BOOK_CHANNELS.recentRemove]: () => undefined,
      [BOOK_CHANNELS.delete]: () => true
    })
    render(<StartView />)
    return b
  }

  it('offers New and Open, which run the File menu commands', async () => {
    const b = setup()
    await userEvent.click(screen.getByRole('button', { name: 'New Book…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open Book…' }))
    expect(b.executed().map(c => c.id)).toEqual([BOOK_COMMANDS.new, BOOK_COMMANDS.open])
  })

  it('lists recent books; a missing one is marked and can only be removed from the list', async () => {
    const b = setup()
    const list = await screen.findByRole('list', { name: 'Recent books' })
    expect(within(list).getByText('Home')).toBeInTheDocument()
    expect(within(list).getByText('/l/Old.tessera (not found)')).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Delete Old' })).toBeDisabled()

    await userEvent.click(within(list).getByRole('button', { name: 'Remove Old from the list' }))
    await userEvent.click(within(list).getByRole('button', { name: 'Delete Home' }))
    expect(b.calls(BOOK_CHANNELS.recentRemove)).toEqual([{ path: '/l/Old.tessera' }])
    expect(b.calls(BOOK_CHANNELS.delete)).toEqual([{ path: '/l/Home.tessera' }])
  })

  it('opens a recent book, and says why when it can\'t', async () => {
    const b = setup({ isOpen: false }, () => ({ ok: false, error: { code: 'UNSUPPORTED_FILE', message: '“Home.tessera” is not a Tessera book.' } }))
    await userEvent.click(await screen.findByText('Home'))
    expect(b.calls(BOOK_CHANNELS.open)).toEqual([{ path: '/l/Home.tessera' }])
    expect(await screen.findByRole('alert')).toHaveTextContent('“Home.tessera” is not a Tessera book.')
  })

  it('shows why the last book could not be reopened, and follows changes to the list', async () => {
    const b = setup({ isOpen: false, error: '“Gone” could not be reopened.' })
    expect(await screen.findByText('“Gone” could not be reopened.')).toBeInTheDocument()
    act(() => b.emit(BOOK_EVENTS.recent, []))
    expect(await screen.findByText('Books you open will be listed here.')).toBeInTheDocument()
  })
})

describe('the book tree', () => {
  const setup = (commands: Record<string, (args: unknown[]) => unknown> = {}) => {
    const b = bridge({ [BOOK_CHANNELS.tree]: () => TREE }, commands)
    render(<BookTree />)
    return b
  }
  const item = (name: string) => screen.getByRole('treeitem', { name: new RegExp(`^${name}$`) })

  it('shows the book and its sub-books as a tree, nested and in order', async () => {
    setup()
    const tree = await screen.findByRole('tree', { name: 'Book Home' })
    expect(within(tree).getAllByRole('treeitem').map(i => [i.textContent, i.getAttribute('aria-level')]))
      .toEqual([['Home', '1'], ['Personal', '2'], ['Rentals', '3'], ['Business', '2']])
    expect(item('Home')).toHaveAttribute('aria-selected', 'true')
  })

  it('adds a sub-book under the selection, then selects it', async () => {
    const b = setup({ [BOOK_COMMANDS.new]: () => ({ kind: 'subBook', id: 'b' }) })
    await screen.findByRole('tree')
    await userEvent.click(screen.getByRole('button', { name: 'New sub-book' }))
    expect(b.executed()).toEqual([{ id: BOOK_COMMANDS.new, args: [{ parentId: null }] }])
    await waitFor(() => expect(item('Business')).toHaveAttribute('aria-selected', 'true'))

    await userEvent.click(item('Personal'))
    await userEvent.click(screen.getByRole('button', { name: 'New sub-book' }))
    expect(b.executed().at(-1)).toEqual({ id: BOOK_COMMANDS.new, args: [{ parentId: 'p' }] })
  })

  it('renames and deletes only sub-books, by button or key', async () => {
    const b = setup()
    await screen.findByRole('tree')
    expect(screen.getByRole('button', { name: 'Rename sub-book' })).toBeDisabled()

    item('Home').focus()
    await userEvent.keyboard('{ArrowDown}{F2}{Delete}')
    expect(item('Personal')).toHaveFocus()
    expect(b.executed()).toEqual([
      { id: BOOK_COMMANDS.renameSubBook, args: [{ id: 'p' }] },
      { id: BOOK_COMMANDS.deleteSubBook, args: [{ id: 'p' }] }
    ])
  })

  it('collapses and expands with the arrow keys', async () => {
    setup()
    await screen.findByRole('tree')
    await userEvent.click(item('Personal'))
    item('Personal').focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(item('Personal')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: 'Rentals' })).toBeNull()
    await userEvent.keyboard('{ArrowLeft}')
    expect(item('Home')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{ArrowRight}')
    expect(item('Rentals')).toBeInTheDocument()
  })

  it('follows changes to the tree, falling back to the book when the selection goes', async () => {
    const b = setup()
    await screen.findByRole('tree')
    await userEvent.click(item('Business'))
    act(() => b.emit(BOOK_EVENTS.tree, { ...TREE, subBooks: TREE.subBooks.filter(s => s.id !== 'b') }))
    await waitFor(() => expect(item('Home')).toHaveAttribute('aria-selected', 'true'))
    act(() => b.emit(BOOK_EVENTS.tree, null))
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull())
  })
})

describe('the New Book dialog', () => {
  const setup = (input: object = { tree: TREE }, create: (data: any) => unknown = () => ({ ok: true, value: sub('n', null, 'New') })) => {
    const b = bridge({ [BOOK_CHANNELS.createSubBook]: create })
    const close = vi.fn()
    const setBusy = vi.fn()
    render(<NewBookDialog input={input as any} close={close} setBusy={setBusy} />)
    return { ...b, close, setBusy }
  }
  const parentField = () => screen.getByRole('combobox', { name: 'Parent book' })

  it('defaults to a new file, closing with its name; nothing is created here', async () => {
    const { close, calls } = setup()
    expect(parentField()).toHaveTextContent('None (create a new book file)')
    expect(screen.getByText('Closes “Home” and creates a new book file.')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' Business {Enter}')
    expect(close).toHaveBeenCalledWith({ kind: 'file', name: 'Business' })
    expect(calls(BOOK_CHANNELS.createSubBook)).toEqual([])
  })

  it('lists the book and every sub-book as parents, and starts on the one asked for', async () => {
    setup({ tree: TREE, parentId: 'r' })
    expect(parentField()).toHaveTextContent('Rentals')
    expect(screen.getByText('Created inside “Rentals”, in the same file.')).toBeInTheDocument()
    await userEvent.click(parentField())
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['None (create a new book file)', 'Home', 'Personal', 'Rentals', 'Business'])
  })

  it('creates a sub-book itself, busy while it saves, and closes with its id', async () => {
    const { close, calls, setBusy } = setup({ tree: TREE, parentId: null })
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Cottage')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(calls(BOOK_CHANNELS.createSubBook)).toEqual([{ name: 'Cottage', parentId: null }])
    expect(setBusy.mock.calls).toEqual([[true], [false]])
    expect(close).toHaveBeenCalledWith({ kind: 'subBook', id: 'n' })
  })

  it('shows a duplicate name on the name field and stays open', async () => {
    const { close } = setup({ tree: TREE, parentId: null },
      () => ({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already a “Personal” there.', field: 'name' } }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Personal{Enter}')
    expect(await screen.findByText('There is already a “Personal” there.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true')
    expect(close).not.toHaveBeenCalled()
  })

  it('checks the name before anything is sent', async () => {
    const { close, calls } = setup({ tree: TREE, parentId: 'p' })
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'a/b')
    expect(screen.getByText(/can’t contain/)).toBeInTheDocument()
    expect(calls(BOOK_CHANNELS.createSubBook)).toEqual([])
    expect(close).not.toHaveBeenCalled()
  })

  it('cancels without a result', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})

describe('the rename dialog', () => {
  const setup = (rename: (data: any) => unknown = data => ({ ok: true, value: sub(data.id, null, data.name) })) => {
    const b = bridge({ [BOOK_CHANNELS.renameSubBook]: rename })
    const close = vi.fn()
    render(<RenameDialog input={{ id: 'p', name: 'Personal', rev: 4 }} close={close} setBusy={vi.fn()} />)
    return { ...b, close }
  }

  it('starts from the current name, and renames with the revision it was shown', async () => {
    const { close, calls } = setup()
    const field = screen.getByRole('textbox', { name: 'Name' })
    expect(field).toHaveValue('Personal')
    await userEvent.clear(field)
    await userEvent.type(field, 'Household{Enter}')
    expect(calls(BOOK_CHANNELS.renameSubBook)).toEqual([{ id: 'p', name: 'Household', expectedRev: 4 }])
    expect(close).toHaveBeenCalledWith({ id: 'p' })
  })

  it('closes without a request when the name is unchanged', async () => {
    const { close, calls } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(calls(BOOK_CHANNELS.renameSubBook)).toEqual([])
    expect(close).toHaveBeenCalledWith({ id: 'p' })
  })

  it('shows a conflict and stays open', async () => {
    const { close } = setup(() => ({ ok: false, error: { code: 'CONFLICT', message: 'This sub-book was changed elsewhere. Try again.' } }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), '2{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('changed elsewhere')
    expect(close).not.toHaveBeenCalled()
  })
})
