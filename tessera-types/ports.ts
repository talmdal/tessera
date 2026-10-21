
export interface Disposable {
  dispose(): void
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}
