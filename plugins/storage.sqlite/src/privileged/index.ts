import fs from 'node:fs'
import path from 'node:path'
import { KitStorageEngine } from '@tessera/storage-kit'
import type { PluginContext } from '@tessera/types'
import { sqliteDriver } from './SqliteDriver'

let engine: KitStorageEngine | undefined

export async function activate(context: PluginContext) {
  const directory = path.join(context.paths, 'storage')
  fs.mkdirSync(directory, { recursive: true })

  engine = new KitStorageEngine(sqliteDriver({ directory }))
  context.services.provide('storage-sqlite', 'storage.engine', engine)
}

/** Runs after every plugin that requires `storage.engine` has deactivated, so their last writes land first. */
export async function deactivate() {
  const closing = engine
  engine = undefined
  await closing?.closeAll()
}
