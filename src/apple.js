import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { heard } from './heard.js'
import { encodeWav } from './wav.js'

/**
 * macOS on-device speech recognition, through native/hear.swift, with the
 * same shape as whisper.js: transcribe(wav) → text, warm(), close().
 *
 * Nothing to install: the recognizer is part of macOS. On synthetic clips it
 * matched whisper on everyday sentences and, with vocabulary hints, on
 * jargon, but it writes no full stops and drops "um" and "uh", which the turn
 * taker uses as signs of an unfinished thought.
 */
export function createAppleSpeech({ binary, hints = [], log = () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-hear-'))
  const child = spawn(binary, hints, { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => log(String(d).trim()))
  const waiting = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const next = waiting.shift()
      if (!next) continue
      if (msg.error) next.reject(new Error(msg.error))
      else next.resolve(msg.text ?? '')
    }
  })
  child.on('exit', (code) => {
    for (const w of waiting.splice(0)) w.reject(new Error(`on-device speech helper exited (${code})`))
  })
  let seq = 0

  async function transcribe(wav) {
    const file = join(dir, `${++seq}.wav`)
    writeFileSync(file, Buffer.from(wav))
    try {
      const text = await new Promise((resolve, reject) => {
        waiting.push({ resolve, reject })
        child.stdin.write(file + '\n')
      })
      return heard(text)
    } finally {
      rmSync(file, { force: true })
    }
  }

  return {
    name: 'apple',
    transcribe,
    warm: () => transcribe(encodeWav(new Float32Array(8000))).catch(() => ''),
    close: () => {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
