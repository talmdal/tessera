// Comparing paths as the platform does.
import path from 'node:path'

/** Paths compare as the platform does: Windows and macOS file systems are usually case-insensitive. */
export const samePath = (a: string, b: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b

/** Whether `file` is directly in `folder` (not in a folder inside it). Both should be resolved, real paths. */
export const isDirectlyIn = (file: string, folder: string) => samePath(path.dirname(path.resolve(file)), path.resolve(folder))
