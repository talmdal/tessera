import type { PluginContext } from '@tessera/types'
import { greeting } from './greeting'

export function activate(context: PluginContext) {
  context.ipc.register('sample-builtin:hello', async () => greeting('a built-in plugin'))
  context.extensions.contribute('sample-builtin', 'shell.views', 'sample-builtin.hello', greeting)
}
