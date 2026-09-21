/**
 * Logging sink for the extension. Writes to stderr because stdout belongs to
 * pi's TUI; keeping the stream boundary in one module means no other module
 * touches a process stream directly.
 */
function write(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`opencode2pi ${level}: ${message}\n`)
}

export const logInfo = (message: string): void => write('info', message)
export const logWarn = (message: string): void => write('warn', message)
export const logError = (message: string): void => write('error', message)
