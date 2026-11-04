import { describe, expect, it } from 'vitest'
import { ICONS_EXTENSION_POINT } from '../../shared/layout/types'
import { setupLayout } from '../helpers/layout'

const register = (extensions: ReturnType<typeof setupLayout>['extensions'], id: string, file = './bank.svg', contributor = 'p') =>
  extensions.contribute(contributor, ICONS_EXTENSION_POINT, id, { id, file })

describe('LayoutService: icons plugins registered', () => {
  it('leaves out a view that names an icon nobody registered', () => {
    const { layout, contribute } = setupLayout()
    layout.attach(1)

    contribute('accounts', 'shell.left', { icon: 'p.bank' })

    expect(layout.get(1).bars.left.views).toEqual([])
  })

  it('shows the view once the icon is registered, and drops it again when the icon goes', () => {
    const { layout, extensions, contribute, changes } = setupLayout()
    layout.attach(1)
    contribute('accounts', 'shell.left', { icon: 'p.bank' })
    changes.length = 0

    const registration = register(extensions, 'p.bank')
    expect(layout.get(1).bars.left.views).toEqual(['accounts'])
    expect(changes.at(-1)?.bars.left.views).toEqual(['accounts'])

    registration.dispose()
    expect(layout.get(1).bars.left.views).toEqual([])
  })

  it('accepts an icon registered by a different plugin', () => {
    const { layout, extensions, contribute } = setupLayout({ p: 'tessera-plugin://p/remoteEntry.js', q: 'tessera-plugin://q/remoteEntry.js' })
    layout.attach(1)
    register(extensions, 'q.bank', './bank.svg', 'q')

    contribute('accounts', 'shell.left', { icon: 'q.bank' })

    expect(layout.get(1).bars.left.views).toEqual(['accounts'])
  })

  it('does the same for a bar item', () => {
    const { layout, extensions, contributeItem } = setupLayout()
    layout.attach(1)
    contributeItem('save', 'shell.top', { icon: 'p.bank' })
    expect(layout.get(1).bars.top.items).toEqual([])

    register(extensions, 'p.bank')

    expect(layout.get(1).bars.top.items).toEqual(['save'])
  })

  it('does not count an invalid registration', () => {
    const { layout, extensions, contribute } = setupLayout()
    layout.attach(1)
    contribute('accounts', 'shell.left', { icon: 'p.bank' })

    extensions.contribute('p', ICONS_EXTENSION_POINT, 'p.bank', { id: 'p.bank', file: './bank.png' })

    expect(layout.get(1).bars.left.views).toEqual([])
  })

  it('still accepts the standard set and plugin files', () => {
    const { layout, contribute } = setupLayout()
    layout.attach(1)

    contribute('a', 'shell.left', { icon: 'Save' })
    contribute('b', 'shell.left', { icon: './b.svg' })

    expect(layout.get(1).bars.left.views).toEqual(['a', 'b'])
  })
})
