/**
 * The talking half: sentences in, spoken one at a time, and out of the way the
 * moment the user has the floor. All of this was learned the hard way:
 *
 *  - One utterance in the synthesiser at a time. `speak` appends, so queueing
 *    them all there meant the answer to her second question waited behind the
 *    whole answer to her first — "Sure, go ahead" arrived 8.2 seconds late.
 *  - `hold` while she is talking: nothing new starts. Instant, because not
 *    starting a sentence loses nothing.
 *  - `hush` once the sound has held long enough to be her: the sentence in the
 *    air stops. What is queued behind it only waits.
 *  - `drop` once what she said becomes a message: everything waiting answers
 *    something she has moved past, so it is thrown away, along with the rest
 *    of that reply still to arrive.
 *  - `release` if it was a chair after all: the rest of the answer comes.
 *
 * It also keeps the one thing the agent cannot know: the last sentence she
 * actually heard, so the next message can tell it where she cut in.
 *
 * `synth` and `Utterance` are the browser's unless a test hands in its own.
 */
export function createMouth({
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  rate = 1.05,
  onSpeaking,
  onIdle,
  /** A sentence was spoken to its end; called with the tag it was said with. */
  onHeard,
} = {}) {
  let queue = []
  let held = false
  let saying = null
  /** Replies at or before this turn were dropped; their stragglers are too. */
  let droppedThrough = 0
  /** The turn she is hearing, the last sentence of it that finished, and
   *  whether she cut in on it. */
  let hearing = { turn: 0, last: '', cut: false }

  function pump() {
    if (held || saying) return
    const next = queue.shift()
    if (!next) return
    const u = new Utterance(next.text)
    u.rate = rate
    u.onstart = () => onSpeaking?.()
    // Tracked here rather than asked of `speechSynthesis.speaking`, which stays
    // true for a moment after a cancel and left the queue stuck.
    const finish = (spoken) => () => {
      if (saying !== u) return
      saying = null
      if (spoken) {
        hearing.last = next.text
        onHeard?.(next.tag)
      }
      if (queue.length) pump()
      else if (!held) onIdle?.()
    }
    u.onend = finish(true)
    // Chrome ends a cancelled utterance with `error`, not `end`.
    u.onerror = finish(false)
    saying = u
    if (next.turn !== hearing.turn) hearing = { turn: next.turn, last: '', cut: false }
    synth.speak(u)
  }

  return {
    /** A sentence of reply `turn`. `tag` comes back through `onHeard`. */
    say(turn, text, tag) {
      if (turn <= droppedThrough || !text) return
      queue.push({ turn, text, tag })
      pump()
    },
    hold() {
      held = true
    },
    release() {
      held = false
      if (queue.length) pump()
      else if (!saying) onIdle?.()
    },
    /** Stop the sentence in the air; what is queued keeps its place. */
    hush() {
      if (saying) hearing.cut = true
      saying = null
      synth.cancel()
    },
    /** She has moved on: forget what is waiting and what is still to come. */
    drop() {
      const turns = [hearing.turn, ...queue.map((q) => q.turn)]
      const newest = Math.max(...turns)
      // A reply that arrived while she was talking and never got a word out:
      // she heard none of it, whatever she heard of the one before.
      if (newest > hearing.turn) hearing = { turn: newest, last: '', cut: true }
      else if (queue.length) hearing.cut = true
      droppedThrough = Math.max(droppedThrough, ...turns)
      queue = []
      held = false
      if (saying) {
        hearing.cut = true
        saying = null
        synth.cancel()
      }
    },
    /** Anything coming out of the speakers, from here or anything else. */
    isSpeaking: () => Boolean(saying) || synth.speaking || synth.pending,
    /**
     * What she heard of the last reply, for the message that follows it, and
     * only once. A reply she heard to the end is not worth mentioning.
     */
    heard() {
      const h = hearing
      hearing = { turn: h.turn, last: '', cut: false }
      return h.cut ? { cut: true, last: h.last } : { cut: false }
    },
    /**
     * The server stopped reply `turn` because she talked over it. Sentences of
     * it can still be on their way, so they are refused on arrival as well as
     * cleared from the queue.
     */
    dropThrough(turn) {
      droppedThrough = Math.max(droppedThrough, turn)
      queue = queue.filter((q) => q.turn > turn)
      if (saying && hearing.turn <= turn) {
        hearing.cut = true
        saying = null
        synth.cancel()
      }
    },
    /** Buy the right to make a sound: iOS speaks only after a gesture. */
    prime() {
      const u = new Utterance(' ')
      u.volume = 0
      synth.speak(u)
    },
  }
}
