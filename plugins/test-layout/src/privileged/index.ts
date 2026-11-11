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
import { IpcMessage, PluginContext, Border, BORDERS } from '@tessera/types'
import { CHANNELS, COMMANDS, PLUGIN_ID, PingRequest, VIEWS, isSide } from '../shared'
import { PluginCommandHandler } from './TestBackend'

const PANEL_ICONS: Record<Border, string> = {
  top: 'ExpandLess', bottom: 'ExpandMore', left: 'ChevronLeft', right: 'ChevronRight'
}

const PANEL_TITLES: Record<Border, string> = {
  top: 'Sample Top', bottom: 'Sample Bottom', left: 'Sample Left', right: 'Sample Right'
}

export function activate(context: PluginContext) {
  const model = new PluginCommandHandler()

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
      if (!isSide(side)) throw new Error(`ping needs a side, one of ${BORDERS.join(', ')}`)
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
    ...BORDERS.map(side => context.extensions.contribute(PLUGIN_ID, V, VIEWS.panel(side), {
      id: VIEWS.panel(side),
      title: PANEL_TITLES[side],
      slot: `shell.${side}`,
      module: `./${capitalize(side)}Panel`,
      icon: PANEL_ICONS[side]
    }))
  )

  // ---- Bar items and a menu entry, bound to the commands above ---------------

  // An icon of our own: registered here, fetched by the renderer when it is first drawn. The file is
  // plugins/test-layout/public/icons/ping.svg, which the build copies next to the renderer remote.
  const PING_ICON = `${PLUGIN_ID}.ping`
  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, 'shell.icons', PING_ICON, { id: PING_ICON, file: './icons/ping.svg' })
  )

  // ---- Themes: colour schemes this plugin offers -----------------------------
  //
  // Declarative data: a variant sets only the tokens it wants to change; the rest come from the shell's theme.
  // One has both a light and a dark variant, so it can follow the system; the other is dark only, so it
  // can't. Choose one in Tools > Options > Appearance (or with the shell.theme.select command).
  const T = 'shell.themes'
  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, T, `${PLUGIN_ID}.sunrise`, {
      id: `${PLUGIN_ID}.sunrise`,
      label: 'Sunrise',
      light: { primary: '#c2410c', secondary: '#a16207', background: { default: '#fff7ed', paper: '#ffffff' } },
      dark: { primary: '#fb923c', secondary: '#facc15', background: { default: '#1c1410', paper: '#271c15' } }
    }),
    context.extensions.contribute(PLUGIN_ID, T, `${PLUGIN_ID}.midnight`, {
      id: `${PLUGIN_ID}.midnight`,
      label: 'Midnight',
      dark: { primary: '#a5b4fc', secondary: '#f0abfc', background: { default: '#05060f', paper: '#0d1020' } }
    })
  )

  const B = 'shell.bar.items'
  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, B, `${PLUGIN_ID}.toolbar.reset`, {
      kind: 'button', id: `${PLUGIN_ID}.toolbar.reset`, slot: 'shell.top', align: 'end',
      label: 'Reset sample', icon: PING_ICON, command: COMMANDS.reset, tooltip: 'Zero the sample counters'
    }),
    context.extensions.contribute(PLUGIN_ID, B, `${PLUGIN_ID}.status.pings`, {
      kind: 'text', id: `${PLUGIN_ID}.status.pings`, slot: 'shell.bottom', align: 'end',
      text: `Sample pings: {${PLUGIN_ID}.pings}`, icon: 'Info', when: `${PLUGIN_ID}.pings`
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