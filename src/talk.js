import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, watch } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMouth } from './mouth.js'
import { pickOption } from './answer.js'
import { CONTINUES_NOTE, heardNote } from './notes.js'
import { createShaper, fallback } from './shape.js'
import { createCarryOn, createTurnTaker } from './turn.js'
import { encodeWav } from './wav.js'
import { createAppleSpeech } from './apple.js'
import { createWhisper, CORE_WORDS, vocabulary } from './whisper.js'

/**
 * `earshot talk`: the voice half of `/talk`, the Claude Code add-on that puts a
 * conversation into an ordinary Code tab session.
 *
 * The add-on can read this process's output and reach it over a Unix socket,
 * and nothing else: it has no microphone and its speech cannot be stopped
 * mid-sentence. So everything that is sound lives here, and the add-on is glue.
 *
 *   in   the microphone, through native/ear.swift (macOS voice processing,
 *        so the agent's own voice does not come back as hers)
 *        the session's reply as it streams, posted by the add-on
 *   out  one JSON line per event on stdout, read by the add-on:
 *          { submit: { text, abort } }   her words, to send as hers
 *          { state }                     listening / hearing / thinking / speaking
 *          { pending }                   what she has said so far this turn
 *          { log }                       for the transcript
 *
 * The loop is the browser page's, unchanged where it can be: the turn taker
 * decides when she has finished, a send within seconds of the last is the rest
 * of it, the mouth holds while she talks and drops what she has moved past,
 * and replies are shaped (steps on screen, choices lettered) before they are
 * said.
 */

const here = dirname(fileURLToPath(import.meta.url))
const PREROLL_SAMPLES = 16000 * 0.4
const TICK_SAMPLES = 800 // 50ms at 16 kHz, the poll the turn taker was tuned on

/**
 * Everything this process says to the add-on, also kept in a log of its own:
 * the add-on's debug lines are not visible from another session, and a silent
 * reply once had to be diagnosed from what was missing rather than what was
 * there. Holds what the user said and what the agent said; local only.
 */
export const TALK_LOG = join(homedir(), '.local', 'state', 'earshot', 'talk.log')
let logTag = ''

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
  try {
    appendFileSync(TALK_LOG, `${new Date().toISOString()} ${logTag} ${JSON.stringify(obj)}\n`)
  } catch {}
}

/** native/ear.swift, compiled once per change into ~/.cache/earshot. */
async function nativeBinary(name, flags = []) {
  const src = join(here, '..', 'native', `${name}.swift`)
  const out = join(homedir(), '.cache', 'earshot', `${name}-${Math.round(statSync(src).mtimeMs)}`)
  if (existsSync(out)) return out
  mkdirSync(dirname(out), { recursive: true })
  emit({ log: `Building earshot's ${name} helper (first run only)…` })
  await new Promise((resolve, reject) =>
    execFile('swiftc', ['-O', ...flags, src, '-o', out], (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())),
  )
  return out
}
const earBinary = () => nativeBinary('ear')

/**
 * `speechSynthesis`, as mouth.js expects it, out of `say` and `afplay`: each
 * sentence rendered to a file (asked for as soon as it arrives), played by a
 * process that can be killed the instant she cuts in.
 */
function createSpeaker({ voice, rate }) {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-talk-'))
  const cache = new Map()
  let seq = 0
  let current = null

  function render(text) {
    if (!cache.has(text)) {
      const file = join(dir, `${++seq}.aiff`)
      const args = ['-o', file]
      if (voice) args.push('-v', voice)
      if (rate) args.push('-r', String(rate))
      args.push('--', text)
      cache.set(text, new Promise((resolve, reject) => execFile('say', args, (err) => (err ? reject(err) : resolve(file)))))
    }
    return cache.get(text)
  }

  const synth = {
    prefetch: (text) => void render(text).catch(() => {}),
    speak(u) {
      if (!u.text.trim()) return
      const play = { u, proc: null, cancelled: false }
      current = play
      render(u.text)
        .then((file) => {
          cache.delete(u.text)
          if (play.cancelled || current !== play) return
          play.proc = spawn('afplay', [file], { stdio: 'ignore' })
          u.onstart?.()
          play.proc.on('exit', () => {
            rmSync(file, { force: true })
            if (current === play) current = null
            if (!play.cancelled) u.onend?.()
          })
        })
        .catch(() => {
          if (current === play) current = null
          if (!play.cancelled) u.onerror?.()
        })
    },
    cancel() {
      const play = current
      current = null
      if (!play) return
      play.cancelled = true
      play.proc?.kill()
      play.u.onerror?.()
    },
    get speaking() {
      return Boolean(current)
    },
    pending: false,
    close: () => {
      synth.cancel()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  class Utterance {
    constructor(text) {
      this.text = text
    }
  }
  return { synth, Utterance }
}

/**
 * How long the microphone waits for the user to start, once they have turned
 * it on, before turning itself off: a microphone left on keeps listening to
 * everything else in the room. Twenty seconds is a first guess, open to
 * tuning.
 */
export const MIC_IDLE_MS = 20_000

export async function talk({ socket, muted: startMuted = false, stt = 'apple', whisperModel, classify = async (c) => fallback(c.block), voice, rate, micIdleMs = MIC_IDLE_MS, cwd = process.cwd() }) {
  // Speech to text: macOS on-device dictation (nothing to install) or
  // whisper.cpp. Which one heard each utterance goes in the log, to compare.
  const whisper =
    stt === 'whisper'
      ? Object.assign(createWhisper({ model: whisperModel, prompt: vocabulary([basename(cwd)]) }), { name: 'whisper' })
      : createAppleSpeech({
          binary: await nativeBinary('hear', ['-parse-as-library']),
          hints: [...CORE_WORDS, basename(cwd)],
          log: (line) => emit({ log: line }),
        })
  void whisper.warm()
  const { synth, Utterance } = createSpeaker({ voice, rate })

  let state = ''
  const show = (s) => {
    if (s === state) return
    state = s
    emit({ state })
  }

  /** Replies are not spoken while muted; earshot is otherwise on. */
  let muted = startMuted

  // ---- the agent's side, as the add-on reports it ------------------------
  let turn = 0
  let running = false
  /** Whether this turn has said or shown anything she could have heard. */
  let spoke = false
  let stopped = false
  let asked = ''
  let shaper = null
  /** The agent's own question, waiting on her answer. */
  let asking = null

  const mouth = createMouth({
    synth,
    Utterance,
    onSpeaking: () => show('speaking'),
    onIdle: () => show(turnTaker.pending() ? 'hearing' : running ? 'thinking' : micOn ? 'listening' : 'mic-off'),
  })

  function newShaper() {
    shaper?.drop()
    shaper = createShaper({
      classify,
      onSay: (text) => {
        spoke = true
        emit({ log: `${muted ? 'muted' : 'say'}: ${text}` })
        if (muted) return
        synth.prefetch(text)
        mouth.say(turn, text)
      },
      onShow: () => {
        spoke = true
      },
    })
    shaper.asked(asked)
  }
  newShaper()

  // ---- her side ------------------------------------------------------------
  const turnTaker = createTurnTaker()
  const carry = createCarryOn()
  let preroll = []
  let prerollSamples = 0
  let recording = null

  async function cut(seq) {
    const samples = join16(recording ?? [])
    recording = null
    try {
      const started = Date.now()
      const text = await whisper.transcribe(encodeWav(samples))
      emit({ log: `heard (${whisper.name}, ${Date.now() - started}ms): ${JSON.stringify(text)}` })
      turnTaker.heard(seq, text)
    } catch (e) {
      emit({ log: `${whisper.name} failed: ${e.message}` })
      turnTaker.heard(seq, null)
    }
    emit({ pending: turnTaker.pending() })
  }

  function heardIt(said) {
    emit({ pending: '' })
    if (asking) {
      const q = asking.questions[asking.index]
      const options = q.options ?? []
      const i = pickOption(said, options)
      asking.answers.push(i === null ? said : options[i].label)
      emit({ log: `answered: ${asking.answers.at(-1)}` })
      asking.index++
      if (asking.index < asking.questions.length) return askNext()
      const { resolve, answers } = asking
      asking = null
      show('thinking')
      return resolve(answers)
    }
    const before = carry.take()
    const text = before ? `${before} ${said}` : said
    carry.sent(text, performance.now())
    mouth.drop()
    const heard = mouth.heard()
    const continues = Boolean(before)
    const note = continues ? CONTINUES_NOTE : heardNote(heard)
    // Talking over a reply stops it; adding something while it works does not.
    const abort = running && (spoke || continues)
    if (abort) {
      stopped = true
      shaper.drop()
      mouth.dropThrough(turn)
    }
    asked = text
    show('thinking')
    emit({ submit: { text: note ? `${note}\n\n${text}` : text, abort } })
    // One turn: her message has gone, so the microphone goes off, after the
    // few seconds in which carrying on counts as the same thought.
    clearTimeout(micTimer)
    micTimer = setTimeout(() => turnTaker.pending() || stopEar('sent'), CARRY_GRACE_MS)
  }

  function level(rms) {
    const out = turnTaker.level(rms, performance.now(), { agentSpeaking: mouth.isSpeaking() })
    if (out.act === 'begin') {
      // She is talking: the microphone stays on until this turn is sent.
      clearTimeout(micTimer)
      carry.resumed(performance.now())
      mouth.hold()
      recording = [...preroll]
      show('hearing')
    } else if (out.act === 'barge') {
      // Voice processing keeps the agent's own voice out of the microphone,
      // so a sound that holds while it talks is her: the sentence stops.
      mouth.hush()
    } else if (out.act === 'cut') {
      void cut(out.seq)
    } else if (out.act === 'discard') {
      recording = null
      if (!turnTaker.pending()) {
        carry.abandon()
        armIdle()
      }
      mouth.release()
    } else if (out.act === 'idle') {
      carry.abandon()
      armIdle()
      mouth.release()
    } else if (out.send) {
      heardIt(out.send)
    }
  }

  // ---- the microphone --------------------------------------------------------
  // Off unless she turns it on, and on for one turn: it goes off once her
  // message is sent, or when she has not started talking within micIdleMs.
  const CARRY_GRACE_MS = 5000
  const earPath = await earBinary()
  let ear = null
  let micOn = false
  let micTimer = null
  let leftover = Buffer.alloc(0)
  let tick = []
  let tickLength = 0

  function armIdle() {
    clearTimeout(micTimer)
    if (micOn) micTimer = setTimeout(() => stopEar('nothing said'), micIdleMs)
  }

  function startEar() {
    if (micOn) return armIdle()
    micOn = true
    leftover = Buffer.alloc(0)
    tick = []
    tickLength = 0
    preroll = []
    prerollSamples = 0
    const child = spawn(earPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    ear = child
    child.stderr.on('data', (d) => emit({ log: String(d).trim() }))
    child.on('exit', (code) => {
      if (ear !== child) return
      ear = null
      if (micOn) {
        micOn = false
        emit({ mic: false, log: `microphone helper exited (${code})` })
        show(running ? 'thinking' : 'mic-off')
      }
    })
    child.stdout.on('data', (chunk) => {
      if (ear !== child) return
      const buf = Buffer.concat([leftover, chunk])
      const whole = buf.length - (buf.length % 4)
      leftover = buf.subarray(whole)
      const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + whole))
      if (recording) recording.push(samples)
      preroll.push(samples)
      prerollSamples += samples.length
      while (prerollSamples - preroll[0].length > PREROLL_SAMPLES) prerollSamples -= preroll.shift().length
      tick.push(samples)
      tickLength += samples.length
      while (tickLength >= TICK_SAMPLES) {
        const all = join16(tick)
        let sum = 0
        for (let i = 0; i < TICK_SAMPLES; i++) sum += all[i] * all[i]
        level(Math.sqrt(sum / TICK_SAMPLES))
        tick = [all.subarray(TICK_SAMPLES)]
        tickLength = tick[0].length
      }
    })
    emit({ mic: true, log: 'microphone on' })
    if (!mouth.isSpeaking()) show(running ? 'thinking' : 'listening')
    armIdle()
  }

  function stopEar(why) {
    clearTimeout(micTimer)
    if (!micOn) return
    micOn = false
    const child = ear
    ear = null
    child?.kill()
    recording = null
    turnTaker.taken()
    carry.abandon()
    mouth.release()
    emit({ mic: false, pending: '', log: `microphone off (${why})` })
    if (!mouth.isSpeaking()) show(running ? 'thinking' : 'mic-off')
  }

  function askNext() {
    const q = asking.questions[asking.index]
    mouth.say(turn, q.question)
    ;(q.options ?? []).slice(0, 4).forEach((o, i) => mouth.say(turn, `Option ${'ABCD'[i]}: ${o.label}.`))
    show('asking')
  }

  // ---- what the add-on tells us ------------------------------------------
  // Text arrives as numbered posts that may land out of order; they are
  // applied in order.
  let nextSeq = 0
  let textChars = 0
  const early = new Map()
  //
  // A post that never arrives must not hold the rest back. Once one went
  // missing during a reply with a long code block, and every reply after
  // it was silent: each waited on the gap. A gap that lasts a second is
  // skipped, and said in the log.
  let gapTimer = null
  function drain() {
    while (early.has(nextSeq)) {
      early.get(nextSeq)()
      early.delete(nextSeq++)
    }
    clearTimeout(gapTimer)
    gapTimer = null
    if (early.size) {
      gapTimer = setTimeout(() => {
        const next = Math.min(...early.keys())
        emit({ log: `skipped missing posts ${nextSeq}–${next - 1}` })
        nextSeq = next
        drain()
      }, 1000)
    }
  }
  function inOrder(seq, apply) {
    if (seq < nextSeq) return emit({ log: `late post ${seq} ignored` })
    early.set(seq, apply)
    drain()
  }

  const routes = {
    mic: ({ on }) => (on ? startEar() : stopEar('turned off')),
    note: ({ text }) => emit({ log: text }),
    // She typed a message: whatever is still being said answers something
    // she has moved past.
    typed: () => {
      mouth.drop()
      mouth.dropThrough(turn)
      show(micOn ? 'listening' : 'mic-off')
    },
    // The Mute button: stop talking, and say nothing until unmuted.
    mute: ({ on }) => {
      muted = Boolean(on)
      if (muted) {
        mouth.drop()
        mouth.dropThrough(turn)
      }
      emit({ log: muted ? 'muted' : 'unmuted' })
      show(running ? 'thinking' : micOn ? 'listening' : 'mic-off')
    },
    'turn-start': () => {
      textChars = 0
      turn++
      running = true
      spoke = false
      stopped = false
      newShaper()
      if (state !== 'hearing') show('thinking')
    },
    text: ({ text }) => {
      textChars += text.length
      if (!stopped) shaper.push(text)
    },
    'text-end': () => stopped || shaper.end(),
    'turn-end': ({ reason }) => {
      emit({ log: `turn ${turn} ended (${reason}); ${textChars} characters of reply received` })
      running = false
      if (reason === 'aborted') shaper.drop()
      else shaper.end()
    },
  }

  logTag = basename(socket, '.sock')
  mkdirSync(dirname(TALK_LOG), { recursive: true })
  if (existsSync(socket)) rmSync(socket)
  mkdirSync(dirname(socket), { recursive: true })
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const msg = body ? JSON.parse(body) : {}
    const route = req.url.slice(1)
    if (route === 'ask') {
      // Held open until she has answered every question; the add-on returns
      // the answers as the tool's result.
      const answers = await new Promise((resolve) => {
        asking = { questions: msg.questions ?? [], index: 0, answers: [], resolve }
        void shaper.settled().then(askNext)
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ answers }))
    }
    if (routes[route]) inOrder(msg.seq ?? nextSeq, () => routes[route](msg))
    res.writeHead(204)
    res.end()
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  emit({ log: `talk is ready (${socket}); microphone off until she turns it on` })
  show('mic-off')

  const quit = () => {
    ear?.kill()
    synth.close()
    whisper.close()
    server.close()
    rmSync(socket, { force: true })
    process.exit(0)
  }
  // A new version of earshot's own code is picked up by itself, so nobody has
  // to type /earshot twice after every change. When
  // the code changes, this process finishes at the next quiet moment (nothing
  // being said, nothing being heard, no question open) and the add-on starts
  // the new one. The add-on's own code still needs /reload-plugins.
  let changed = false
  for (const dir of [here, join(here, '..', 'native')]) {
    try {
      watch(dir, { recursive: true }, (_, file) => {
        if (/\.(js|swift)$/.test(String(file))) changed = true
      })
    } catch {}
  }
  setInterval(() => {
    const quiet = !mouth.isSpeaking() && !recording && !turnTaker.pending() && !asking && !(micOn && state === 'hearing')
    if (!changed || !quiet) return
    emit({ restart: true, log: 'earshot changed; restarting with the new version' })
    quit()
  }, 1000)

  // The add-on kills this process when /talk is turned off or the session
  // ends; its stdin is not a signal, since it may be closed from the start.
  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
  process.on('SIGHUP', quit)
}

function join16(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
