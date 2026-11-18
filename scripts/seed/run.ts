// The bundled entry point: scripts/seed-book.mts builds this file and calls `run`.
import { main } from './main'

export async function run(argv: string[]): Promise<void> {
  await main(argv)
}
