import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { findModel } from './whisper.js'

function command(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim()
  } catch {
    return null
  }
}

/** Check prerequisites without starting audio, compiling, or downloading. */
export function checkSetup(stt = 'apple') {
  const checks = []
  const check = (ok, message) => checks.push({ ok: Boolean(ok), message })
  check(Number(process.versions.node.split('.')[0]) >= 22, `Node.js 22 or later (found ${process.versions.node})`)
  check(platform() === 'darwin', 'macOS is required')
  if (platform() !== 'darwin') return checks

  const macOS = command('/usr/bin/sw_vers', ['-productVersion'])
  if (stt === 'apple') check(Number(macOS?.split('.')[0]) >= 26, `Apple speech recognition needs macOS 26 or later (found ${macOS ?? 'unknown'}). Use Whisper on older macOS.`)

  const swift = command('/usr/bin/xcrun', ['--find', 'swiftc'])
  check(swift, 'Swift compiler. If missing, run: xcode-select --install')
  if (stt === 'apple' && swift) {
    const sdk = command('/usr/bin/xcrun', ['--show-sdk-version'])
    check(Number(sdk?.split('.')[0]) >= 26, `Apple speech recognition needs a macOS 26 or later SDK (found ${sdk ?? 'unknown'}). Update the Apple developer tools if needed.`)
  }
  for (const tool of ['say', 'afplay']) check(command('/usr/bin/which', [tool]), `${tool} is available`)
  if (stt === 'whisper') {
    check(command('/usr/bin/which', ['whisper-cli']), 'whisper-cli. If missing, run: brew install whisper-cpp')
    check(findModel(), 'Whisper model at EARSHOT_WHISPER_MODEL or ~/.cache/earshot/ggml-base.en.bin')
  }
  return checks
}
