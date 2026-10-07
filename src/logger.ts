/**
 * Logging sink for the extension. Always appends to
 * ~/.opencode2pi/opencode2pi.log, and additionally echoes to stderr in the
 * non-interactive modes (print, JSON, RPC) where nothing is rendering the
 * terminal. In the TUI a raw stderr write lands mid-frame and scribbles over
 * the screen, so there the log file is the only sink. Keeping the stream
 * boundary in one module means no other module touches a process stream or a
 * file directly.
 */
import { appendFile, mkdir, stat, truncate } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_DIR = join(homedir(), '.opencode2pi')
const LOG_PATH = join(LOG_DIR, 'opencode2pi.log')
const MAX_BYTES = 2 * 1024 * 1024

/** Appends are chained so concurrent writes cannot interleave mid-line. */
let queue: Promise<void> = Promise.resolve()
let dirReady = false
let sizeChecked = false

/**
 * pi takes over stdout (redirecting it to stderr) only for the non-interactive
 * modes, which leaves an own `write` property on the stdout stream. Its absence
 * means a TUI owns the terminal.
 */
function tuiOwnsTerminal(): boolean {
  return !Object.hasOwn(process.stdout, 'write')
}

function write(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} opencode2pi ${level}: ${message}\n`
  if (!tuiOwnsTerminal()) process.stderr.write(line)
  queue = queue
    .then(async () => {
      if (!dirReady) {
        await mkdir(LOG_DIR, { recursive: true })
        dirReady = true
      }
      if (!sizeChecked) {
        sizeChecked = true
        // Once per process: a failure loop must not fill the disk.
        const size = await stat(LOG_PATH).then(
          (s) => s.size,
          () => 0,
        )
        if (size > MAX_BYTES) await truncate(LOG_PATH, 0)
      }
      await appendFile(LOG_PATH, line, 'utf8')
    })
    .catch(() => {}) // logging must never break the extension
}

export const logInfo = (message: string): void => write('info', message)
export const logWarn = (message: string): void => write('warn', message)
export const logError = (message: string): void => write('error', message)
