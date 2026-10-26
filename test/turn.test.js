import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnTaker } from '../src/turn.js'

/**
 * The turn boundary, driven by hand.
 *
 * There is no way to test this with a voice from here: Chrome's
 * `--use-file-for-fake-audio-capture` feeds silence, so the microphone is
 * replaced by a level envelope and the clock by a number, which exercises every
 * decision the detector makes and none of the capture.
 *
 * The envelopes below are real sessions, measured: these are the pauses a
 * speaker really leaves, and no one can speak them again on demand.
 */

/** The slice of vitest's `expect` these tests use, over node:assert. */
function expect(actual) {
  return {
    toBe: (want) => assert.equal(actual, want),
    toEqual: (want) => assert.deepEqual(actual, want),
    toHaveLength: (n) => assert.equal(actual.length, n),
  }
}

/** Runs the poll at the 50ms the page uses, and answers each cut like whisper. */
class Rig {
  now = 0
  taker = createTurnTaker()
  sends = []
  acts = []
  /** What the transcriber returns, in cut order. */
  script
  /** How long transcription takes. Measured at 210ms steady state. */
  lag = 250
  #queue = []
  #taken = 0

  constructor(script) {
    this.script = script
  }

  tick(rms) {
    for (const q of this.#queue.filter((q) => q.at <= this.now)) this.taker.heard(q.seq, q.text)
    this.#queue = this.#queue.filter((q) => q.at > this.now)

    const out = this.taker.level(rms, this.now, { agentSpeaking: false })
    if (out.act) this.acts.push(out.act)
    if (out.act === 'cut') {
      const text = this.script[this.#taken++] ?? ''
      this.#queue.push({ at: this.now + this.lag, seq: out.seq, text })
    }
    if (out.send) this.sends.push(out.send)
    this.now += 50
  }

  /** Speaking, at the level Chrome's fake microphone reads through the real path. */
  say(ms) {
    for (let i = 0; i < Math.round(ms / 50); i++) this.tick(0.365)
    return this
  }

  hush(ms) {
    for (let i = 0; i < Math.round(ms / 50); i++) this.tick(0)
    return this
  }
}

/** What was said in one real session, in the order it was said. */
const HER_SESSION = [
  "Well, I'm testing the talk feature now.",
  'I wonder how it does at...',
  'Detecting pauses in speech.',
  'And, designing when to hit the send.',
  "It feels as though it's being a little aggressive.",
]

/** The gaps a person leaves while deciding what to say next. */
function speakHerSession(r) {
  return r
    .say(2000)
    .hush(900)
    .say(1500)
    .hush(800)
    .say(1500)
    .hush(1000)
    .say(1800)
    .hush(900)
    .say(2200)
    .hush(5000)
}

/**
 * The first version made a single thought into five messages in twenty-four
 * seconds.
 */
describe('one thought with pauses in it', () => {
  test('is one message, not five', () => {
    const r = speakHerSession(new Rig(HER_SESSION))

    // Five recordings still, which is what she got five messages from: the old
    // rule sent each one as its words came back and never asked whether she had
    // stopped. The recordings are not the problem and they are still cut here.
    expect(r.acts.filter((a) => a === 'cut')).toHaveLength(5)
    expect(r.sends).toHaveLength(1)
    expect(r.sends[0]).toBe(
      "Well, I'm testing the talk feature now. I wonder how it does at " +
        'Detecting pauses in speech. And, designing when to hit the send. ' +
        "It feels as though it's being a little aggressive.",
    )
  })
})

/**
 * From a real session. Whisper heard "Um." and then a clause ending in
 * "watching...", the speaker paused about three and a half seconds, and went
 * on with the rest. The old wait was 2.6s.
 */
describe('a thought that trails off', () => {
  test('waits out a thinking pause', () => {
    const r = new Rig(['Um.', 'Reading the logs and checking...', 'whether the build passed.'])
    r.say(400).hush(900).say(1500).hush(3500).say(1500).hush(6000)
    expect(r.sends).toEqual(['Um. Reading the logs and checking whether the build passed.'])
  })
})
