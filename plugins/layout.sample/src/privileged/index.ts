// plugins/layout.sample/src/privileged/index.ts
//
// A sample plugin that puts a view in every slot of the window manager and
// shows the full round trip:
//
//   a button in a bar view ── window.api.invoke('layout-sample:ping') ──► here
//   here ── context.events.emit('changed', state) ──► every view re-renders
//   here ── shell.layout.reveal ──► the main area switches to the Detail page
//
// Nothing in the views holds state: they subscribe to the event, request the
// current snapshot, and render whatever the privileged side last sent.
import type { IpcMessage, PluginContext } from '@tessera/types'
import { CHANNELS, COMMANDS, PLUGIN_ID, PingRequest, SIDES, Side, VIEWS, isSide } from '../shared'
import { SampleModel } from './SampleModel'

const PANEL_ICONS: Record<Side, string> = {
  top: 'chevron-up', bottom: 'chevron-down', left: 'chevron-left', right: 'chevron-right'
}

const PANEL_TITLES: Record<Side, string> = {
  top: 'Sample Top', bottom: 'Sample Bottom', left: 'Sample Left', right: 'Sample Right'
}

export function activate(context: PluginContext) {
  const model = new SampleModel()

  /** Pushes the new state to every view and mirrors the bits menus may care about into context keys. */
  const publish = () => {
    const state = model.snapshot()
    context.events.emit('changed', state)                    // arrives as 'layout-sample:changed'
    context.contextKeys.set(`${PLUGIN_ID}.pings`, state.total)
    context.contextKeys.set(`${PLUGIN_ID}.lastSide`, state.last?.side)
  }

  /** Asks the window manager to show one of our main-area pages, when it is around. */
  const show = async (viewId: string) => {
    if (!context.commands.has('shell.layout.reveal')) return
    await context.commands.execute('shell.layout.reveal', viewId)
  }

  // ---- Requests from the views -----------------------------------------------

  context.subscriptions.push(
    context.ipc.register(CHANNELS.state, () => model.snapshot()),

    context.ipc.register(CHANNELS.ping, async (msg: IpcMessage<PingRequest>) => {
      const side = msg.data?.side
      if (!isSide(side)) throw new Error(`ping needs a side, one of ${SIDES.join(', ')}`)
      context.logger.info(`[${PLUGIN_ID}] ping from the ${side} bar`)
      const state = model.ping(side)
      publish()
      await show(VIEWS.detail)          // the content page changes in response
      return state
    }),

    context.ipc.register(CHANNELS.reset, async () => {
      const state = model.reset()
      publish()
      await show(VIEWS.dashboard)
      return state
    })
  )

  // ---- Commands, so menus and bar items can do the same things ---------------

  context.commands.register(COMMANDS.reset, async () => {
    model.reset()
    publish()
    await show(VIEWS.dashboard)
  }, { enablement: `${PLUGIN_ID}.pings` })

  context.commands.register(COMMANDS.showDashboard, () => show(VIEWS.dashboard))

  // ---- Views: one in every slot ----------------------------------------------

  const V = 'shell.views'
  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, V, VIEWS.dashboard,
      { id: VIEWS.dashboard, title: 'Sample Dashboard', slot: 'shell.main', module: './Dashboard', order: 0 }),
    context.extensions.contribute(PLUGIN_ID, V, VIEWS.detail,
      { id: VIEWS.detail, title: 'Sample Detail', slot: 'shell.main', module: './Detail', order: 1 }),
    ...SIDES.map(side => context.extensions.contribute(PLUGIN_ID, V, VIEWS.panel(side), {
      id: VIEWS.panel(side),
      title: PANEL_TITLES[side],
      slot: `shell.${side}`,
      module: `./${capitalize(side)}Panel`,
      icon: PANEL_ICONS[side]
    }))
  )

  // ---- Bar items and a menu entry, bound to the commands above ---------------

  const B = 'shell.bar.items'
  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, B, `${PLUGIN_ID}.toolbar.reset`, {
      kind: 'button', id: `${PLUGIN_ID}.toolbar.reset`, slot: 'shell.top', align: 'end',
      label: 'Reset sample', icon: 'circle-filled', command: COMMANDS.reset, tooltip: 'Zero the sample counters'
    }),
    context.extensions.contribute(PLUGIN_ID, B, `${PLUGIN_ID}.status.pings`, {
      kind: 'text', id: `${PLUGIN_ID}.status.pings`, slot: 'shell.bottom', align: 'end',
      text: 'Sample pings: {layout-sample.pings}', icon: 'info', when: `${PLUGIN_ID}.pings`
    }),
    context.extensions.contribute(PLUGIN_ID, 'shell.menus', `${PLUGIN_ID}.menu.dashboard`, {
      kind: 'item', id: `${PLUGIN_ID}.menu.dashboard`, label: 'Sample &Dashboard',
      parent: 'shell.view', command: COMMANDS.showDashboard
    })
  )

  publish()
}

function capitalize(word: string) {
  return word[0].toUpperCase() + word.slice(1)
}
