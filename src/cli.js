#!/usr/bin/env node
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chooseClassifier } from './classify.js'
import { talk } from './talk.js'
import { findModel } from './whisper.js'
import { checkSetup } from './setup.js'

const HELP = `earshot: hear your coding agent, and talk back to it, out loud.

earshot is driven by its Claude Code plugin: /talk (or /earshot) in a session
turns it on, and the plugin starts the command below. It is not usually run
by hand.

Usage: earshot talk --socket <path> [options]
       earshot doctor [--stt apple|whisper]

doctor checks prerequisites without starting the microphone or downloading.

  --cwd <dir>         where the session works (a hint for speech recognition)
  --stt <engine>      speech to text: apple (default; macOS on-device
                      dictation, macOS 26+ and developer tools) or whisper (whisper.cpp:
                      brew install whisper-cpp, plus a model, see below)
  --voice <name>      a macOS voice for replies (see: say -v '?')
  --muted             start with spoken replies muted
  --rate <wpm>        how fast replies are spoken
  --mic-idle <secs>   how long the mic waits for you to start before turning
                      itself off (default 20)
  --shape <how>       how lists in a reply are sorted into steps (shown),
                      choices (read as A, B, C) and the rest (read):
                      rules (default; by their markup, on this Mac), or,
                      experimental, gemma (LM Studio, on this Mac) or jev
                      (TypeSafe, hosted: list text is sent to TypeSafe;
                      key from TYPESAFE_API_KEY or the Keychain item
                      "typesafe-api-key"). Model choices are logged to
                      ~/.local/state/earshot/shape.jsonl

With --stt whisper, the model is read from $EARSHOT_WHISPER_MODEL, or
~/.cache/earshot/ggml-base.en.bin.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    socket: { type: 'string' },
    cwd: { type: 'string' },
    voice: { type: 'string' },
    rate: { type: 'string' },
    'mic-idle': { type: 'string' },
    shape: { type: 'string', default: 'rules' },
    stt: { type: 'string', default: 'apple' },
    muted: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help || !['talk', 'doctor'].includes(positionals[0])) {
  console.log(HELP)
  process.exit(values.help ? 0 : 2)
}
if (!['apple', 'whisper'].includes(values.stt)) {
  console.error(`earshot: --stt is apple or whisper, not "${values.stt}".`)
  process.exit(2)
}
if (positionals[0] === 'doctor') {
  const checks = checkSetup(values.stt)
  for (const { ok, message } of checks) console.log(`${ok ? 'OK' : 'MISSING'}: ${message}`)
  process.exit(checks.every((c) => c.ok) ? 0 : 1)
}
if (!values.socket) {
  console.error('earshot talk: --socket is required')
  process.exit(2)
}
const missing = checkSetup(values.stt).filter((c) => !c.ok)
if (missing.length) {
  for (const { message } of missing) console.error(`earshot: ${message}`)
  process.exit(2)
}
const model = values.stt === 'whisper' ? findModel() : null
if (values.stt === 'whisper' && !model) {
  console.error('earshot: no whisper model. Set EARSHOT_WHISPER_MODEL to a ggml-base.en.bin, or put one at ~/.cache/earshot/.')
  process.exit(2)
}

let classify
try {
  ;({ classify } = await chooseClassifier(values.shape))
} catch (e) {
  console.error(`earshot: ${e.message}`)
  process.exit(2)
}

await talk({
  socket: values.socket,
  stt: values.stt,
  muted: values.muted,
  whisperModel: model,
  classify,
  voice: values.voice,
  rate: values.rate,
  micIdleMs: values['mic-idle'] ? Number(values['mic-idle']) * 1000 : undefined,
  cwd: resolve(values.cwd ?? process.cwd()),
})
