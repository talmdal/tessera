import { main } from './main'

export async function run(argv: string[]): Promise<void> {
  process.exitCode = await main(argv)
}
