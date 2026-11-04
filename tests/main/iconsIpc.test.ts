import { describe, expect, it } from 'vitest'
import type { BorderItemDescriptor, RegisteredIcon } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import {
  BAR_ITEMS_EXTENSION_POINT,
  BAR_ITEMS_LIST_CHANNEL,
  ICONS_CHANGED,
  ICONS_EXTENSION_POINT,
  ICONS_LIST_CHANNEL
} from '../../shared/layout/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { VIEWS_CHANGED, VIEWS_EXTENSION_POINT, VIEWS_LIST_CHANNEL } from '../../shared/views/types'
import { registerBorderItemsIpc } from '../../shell/main/layout/borderItemsIpc'
import { registerIconsIpc } from '../../shell/main/layout/iconsIpc'
import { registerShellEvents } from '../../shell/main/events/shellEvents'
import { registerViewsIpc } from '../../shell/main/views/viewsIpc'
import { createLogger } from '../helpers/runtime'

const iconUrlFor = (pluginId: string, relative: string) => pluginId === 'headless' ? undefined : `tessera-plugin://${pluginId}/${relative}`
const remoteEntryFor = (pluginId: string) => `tessera-plugin://${pluginId}/remoteEntry.js`

function setup() {
  const log = createLogger()
  const runtime = createPluginRuntime(undefined, log)
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  const events: string[] = []
  const publish = (event: string) => { events.push(event) }

  registerIconsIpc(shell, iconUrlFor, publish, log)
  registerViewsIpc(shell, remoteEntryFor, iconUrlFor, log)
  registerBorderItemsIpc(shell, iconUrlFor, publish, log)

  const ask = (channel: string) => runtime.ipc.dispatch({ channel })
  const register = (id: string, file = './bank.svg', contributor = 'p') =>
    runtime.extensions.contribute(contributor, ICONS_EXTENSION_POINT, id, { id, file })
  return { runtime, shell, log, events, ask, register }
}

describe('registerIconsIpc', () => {
  it('lists the registered icons with the URL each is fetched from, and nothing else', async () => {
    const { ask, register } = setup()
    register('p.bank', './icons/bank.svg')
    register('p.card')

    const response = await ask(ICONS_LIST_CHANNEL)

    expect(response).toEqual({
      ok: true,
      data: [
        { id: 'p.bank', url: 'tessera-plugin://p/icons/bank.svg', pluginId: 'p' },
        { id: 'p.card', url: 'tessera-plugin://p/bank.svg', pluginId: 'p' }
      ] satisfies RegisteredIcon[]
    })
  })

  it('lists nothing when no plugin registers an icon', async () => {
    const { ask } = setup()

    await expect(ask(ICONS_LIST_CHANNEL)).resolves.toEqual({ ok: true, data: [] })
  })

  it('warns about an invalid registration, and still lists the valid ones', async () => {
    const { ask, register, runtime, log } = setup()
    runtime.extensions.contribute('p', ICONS_EXTENSION_POINT, 'p.bad', { id: 'p.bad', file: './x.png' })
    register('p.good')

    const response = await ask(ICONS_LIST_CHANNEL)

    expect((response as any).data.map((i: RegisteredIcon) => i.id)).toEqual(['p.good'])
    expect(log.warn).toHaveBeenCalledWith('[icons] Icon "p.bad" must be an .svg file')
  })

  it('announces a change when a plugin registers an icon, and when it is removed', () => {
    const { register, events } = setup()

    const registration = register('p.bank')
    registration.dispose()

    expect(events.filter(e => e === ICONS_CHANGED)).toHaveLength(2)
  })

  it('announces nothing for other extension points', () => {
    const { runtime, events } = setup()

    runtime.extensions.contribute('p', 'shell.menus', 'p.m', { kind: 'menu', id: 'p.m', label: 'M' })

    expect(events).not.toContain(ICONS_CHANGED)
  })
})

describe('views and bar items that name a registered icon', () => {
  it('are listed once the icon is registered, and not before', async () => {
    const { runtime, ask, register } = setup()
    runtime.extensions.contribute('p', VIEWS_EXTENSION_POINT, 'p.v', { id: 'p.v', title: 'V', slot: 'shell.left', module: './V', icon: 'p.bank' })
    runtime.extensions.contribute('p', BAR_ITEMS_EXTENSION_POINT, 'p.i', { kind: 'button', id: 'p.i', slot: 'shell.top', label: 'I', command: 'p.c', icon: 'p.bank' })
    expect((await ask(VIEWS_LIST_CHANNEL) as any).data).toEqual([])
    expect((await ask(BAR_ITEMS_LIST_CHANNEL) as any).data).toEqual([])

    register('p.bank')

    expect((await ask(VIEWS_LIST_CHANNEL) as any).data.map((v: { id: string, icon: string }) => [v.id, v.icon])).toEqual([['p.v', 'p.bank']])
    expect(((await ask(BAR_ITEMS_LIST_CHANNEL) as any).data as BorderItemDescriptor[]).map(i => [i.id, i.icon])).toEqual([['p.i', 'p.bank']])
  })

  it('are announced again when an icon arrives later, so the renderer re-lists them', () => {
    const log = createLogger()
    const runtime = createPluginRuntime(undefined, log)
    const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
    const names: string[] = []
    runtime.events.subscribe(event => names.push(event.name))
    registerShellEvents(shell, runtime)

    runtime.extensions.contribute('p', ICONS_EXTENSION_POINT, 'p.bank', { id: 'p.bank', file: './bank.svg' })

    expect(names).toContain(VIEWS_CHANGED)
  })

  it('refresh bar items too: a button\'s icon may be what makes it valid', () => {
    const { runtime, register, events } = setup()
    runtime.extensions.contribute('p', BAR_ITEMS_EXTENSION_POINT, 'p.i', { kind: 'button', id: 'p.i', slot: 'shell.top', label: 'I', command: 'p.c', icon: 'p.bank' })
    events.length = 0

    register('p.bank')

    expect(events).toContain('shell:bar.items.changed')
  })
})
