import type { PluginContext } from '../../../../../../core/plugins/PluginContext'
import { greeting } from './greeting'

export function activate(context: PluginContext) {
  context.ipc.handle('hello', async () => greeting('a built-in plugin'))
  context.extensions.contribute('shell.views', {
    id: 'sample-builtin.hello', title: 'Hello', slot: 'shell.main', module: './HelloView'
  })
}
