import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { heard } from './heard.js'
import { encodeWav } from './wav.js'

/**
 * Local transcription through `whisper-cli` (Homebrew's whisper-cpp).
 *
 * Measured on an Apple silicon Mac with ggml-base.en: a sentence spoken by
 * `say` came back exactly, in 0.22s. The first run after a while takes about
 * 8s while Metal compiles its shaders, so `warm` spends that at startup rather
 * than on the first thing the user says.
 */

/** Where the model is looked for, first match wins. */
export function findModel(env = process.env) {
  const candidates = [
    env.EARSHOT_WHISPER_MODEL,
    join(homedir(), '.cache', 'earshot', 'ggml-base.en.bin'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * Words a general speech model has never seen and that come up constantly.
 * whisper biases decoding toward its prompt; measured: without one
 * "Tailscale" came back as "tail scale" and "ChatGPT" as "chat GPT". Written
 * as a sentence because the prompt is decoded as text that came before.
 */
export const CORE_WORDS = ['Claude', 'Codex', 'earshot', 'ChatGPT', 'Opus', 'Sonnet', 'Haiku', 'git', 'GitHub', 'repo', 'README', 'npm']

export function vocabulary(extra = []) {
  const seen = new Set()
  const words = []
  for (const w of [...CORE_WORDS, ...extra]) {
    const t = String(w).trim()
    if (!t || t.length > 30 || /[/\\]/.test(t) || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    words.push(t)
  }
  return words.join(', ') + '.'
}

export function createWhisper({ model, bin = 'whisper-cli', prompt = vocabulary(), run = execFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-'))
  let seq = 0

  /** A WAV in, the words out; '' for nothing that was speech. */
  async function transcribe(wav) {
    const file = join(dir, `${Date.now()}-${++seq}.wav`)
    writeFileSync(file, Buffer.from(wav))
    try {
      const out = await new Promise((resolve, reject) => {
        run(
          bin,
          ['-m', model, '-f', file, '-nt', '-np', '--no-timestamps', '--prompt', prompt],
          { timeout: 30_000, maxBuffer: 1 << 20 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        )
      })
      return heard(out)
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('whisper-cli is not installed. Run: brew install whisper-cpp')
      throw e
    } finally {
      rmSync(file, { force: true })
    }
  }

  return {
    transcribe,
    /** Half a second of silence, to pay the cold start now. */
    warm: () => transcribe(encodeWav(new Float32Array(8000))).catch(() => ''),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}
