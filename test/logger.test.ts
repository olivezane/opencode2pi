import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

test('the TUI gets the log file and never a stderr write', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode2pi-log-'))
  const previousHome = process.env.HOME
  const stderrWrites: string[] = []
  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(String(chunk))
    return true
  }) as unknown as typeof process.stderr.write
  process.env.HOME = home
  try {
    // Imported after HOME is set: the sink resolves its path at import time.
    const { logWarn } = await import('../src/logger.ts')
    logWarn('catalog refresh issue: fetch failed')

    const logPath = join(home, '.opencode2pi', 'opencode2pi.log')
    let text = ''
    for (let attempt = 0; attempt < 100 && !text; attempt++) {
      await delay(10)
      text = await readFile(logPath, 'utf8').catch(() => '')
    }
    assert.match(text, /opencode2pi warn: catalog refresh issue: fetch failed/)
    assert.deepEqual(stderrWrites, [])
  } finally {
    process.env.HOME = previousHome
    process.stderr.write = originalWrite
  }
})

test('non-interactive mode echoes to stderr too', async () => {
  const stderrWrites: string[] = []
  const originalStderrWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(String(chunk))
    return true
  }) as unknown as typeof process.stderr.write
  // Same behaviour, own property: exactly the shape pi's stdout takeover leaves.
  Object.defineProperty(process.stdout, 'write', {
    value: process.stdout.write.bind(process.stdout),
    configurable: true,
    writable: true,
  })
  try {
    const { logWarn } = await import('../src/logger.ts')
    logWarn('catalog refresh issue: fetch failed')
    assert.match(stderrWrites.join(''), /opencode2pi warn: catalog refresh issue: fetch failed\n$/)
  } finally {
    delete (process.stdout as unknown as { write?: unknown }).write
    process.stderr.write = originalStderrWrite
  }
})
