/**
 * Turn-taking: deciding when the speaker has finished, not when she has paused.
 *
 * The first version sent on 700ms of silence and chopped a single thought into
 * five messages in twenty-four seconds — "I wonder how it does at…" went on its
 * own, and "Detecting pauses in speech." followed it as a second message. It
 * felt aggressive. No length of silence fixes that: a person
 * composing a thought out loud pauses in the middle of a sentence for longer
 * than she pauses at the end of one, so a threshold either cuts her off or
 * feels dead.
 *
 * So there are two boundaries here, not one.
 *
 *   The utterance boundary (700ms) still ends a *recording*. It is no longer a
 *   send. It exists to get the words back early — transcription is ~210ms — so
 *   that the second boundary can read them.
 *
 *   The turn boundary decides the send, out of three things:
 *     - the words. "at…", "because", "the" cannot end an English sentence, so
 *       the wait more than doubles. A finished sentence gets the short wait.
 *     - her rhythm. Every time she resumes inside the boundary, the boundary
 *       moves up to just past that gap; every time she is sent too early and
 *       carries on regardless, it moves up again; a run of clean turns walks it
 *       back down. That is the setting, learned, rather than a slider that
 *       hands her the problem.
 *     - a ceiling, so a sentence she never finishes still goes.
 *
 * This file is pure: every method takes the clock, and nothing here touches a
 * microphone. That is deliberate — Chrome's fake capture feeds silence in this
 * build, so the only honest way to test the boundary is to drive it with a
 * synthetic level envelope, which `test/turn.test.js` does.
 */

/**
 * Below this is a quiet room. Measured against a real microphone.
 *
 * A floor, not the threshold. With a fixed threshold, in a room with something
 * running in it, every sentence the agent spoke was cut within a fraction of a
 * second: the room's noise was taken for the user speaking. A fixed number cannot tell a fan from a person, so this is only the quietest
 * the threshold is ever allowed to be, and `noiseFactor` sets the rest.
 */
const SPEAKING_RMS = 0.015

const DEFAULTS = {
  speakingRms: SPEAKING_RMS,
  /** How far above the room's own level a sound has to sit to be her. */
  noiseFactor: 2.5,
  /** How fast the room's level is allowed to climb, in RMS per second. It
   *  falls to any new quiet at once and climbs slowly, so a fan raises it
   *  within a few seconds and her own voice never does. */
  noiseRisePerSec: 0.01,
  /** The loudest a room is allowed to be taken for. Her voice reads 0.365
   *  through the real path, so this leaves the threshold at most 0.2 however
   *  loud the room gets — a room past this cannot be worked in anyway, and
   *  without the cap a long unbroken sentence would teach it to go deaf. */
  noiseCeil: 0.08,
  /** How long a sound has to hold before it stops a sentence the agent is already
   *  saying. Nothing *new* starts the instant she makes a sound — that costs
   *  nothing. Taking the words out of the air costs her the answer, so it
   *  waits for proof. */
  bargeMs: 250,
  /** Ends a recording, not a turn. */
  utteranceGapMs: 700,
  /** Anything shorter than this is a cough, a chair, or a door. */
  minUtteranceMs: 350,
  /** The shortest a finished-sounding sentence ever waits. */
  floorMs: 1200,
  /** How far her own rhythm is allowed to push the wait. */
  adaptCeilMs: 2600,
  /** The longest anything ever waits, and what a thought that trails off
   *  ("watching…", "um") waits for. In real use a thinking pause after a
   *  trailing "...and watching..." ran about 3.5s, and 2.6s sent half the
   *  thought. */
  ceilMs: 5000,
  /** What an unfinished clause multiplies the wait by. */
  unfinishedFactor: 2.2,
  /** How far above an observed pause to sit, and how much one mistake moves it. */
  marginMs: 300,
  /** How much a clean turn walks it back. Three clean turns undo one mistake:
   *  being cut off is worse than waiting, so it relaxes slower than it gives. */
  decayMs: 100,
  /** Resuming this soon after a send says the send was early, whatever she says. */
  graceMs: 1500,
  /** Resuming this soon and starting with "and" says the same thing. */
  continueGraceMs: 3000,
  /** If a transcription never comes back, send what did. */
  stuckMs: 6000,
}

/**
 * Words an English sentence does not end on.
 *
 * Only the ones that are near-impossible finally, because whisper punctuates
 * every segment it emits — a full stop after "and" is its guess, not hers. The
 * merely unlikely ones ("that", "how", "up") are left out: they end sentences
 * often enough that treating them as unfinished would add a second and a half
 * to "I like that." Anything ending without a full stop is already caught below.
 */
const HANGING = new Set(
  ('and but or nor of to for with from into onto the a an my your our their its ' +
    'because although unless whether than at by about over between through toward ' +
    'towards upon within without per via another each every is are was were am be ' +
    'been being does did will would shall should must might whose')
    .split(' '),
)

/**
 * Words she starts on when she is carrying on from what was already sent.
 *
 * Used only as evidence that a send fired too early, and the cost of a wrong
 * guess is 300ms on the next boundary, so a common opener like "so" or "well"
 * is worth having in here.
 */
const CONTINUES = new Set(
  ('and but so or nor yet because cause since although though while plus also then ' +
    'actually basically anyway well um uh erm which that whereas however meaning')
    .split(' '),
)

/**
 * What she says while deciding what to say. A thought that ends on one of these
 * has not ended, and whisper writes "Um." with a full stop like any sentence.
 */
const FILLERS = new Set('um umm uh uhh erm er hmm mm ah'.split(' '))

// Digits count as words. Without them "Count slowly from 1 to 20" ends, as far
// as this is concerned, on "to" — a hanging word — so a finished sentence was
// read as her still talking and every "set it to 5" waited for nothing.
const words = (t) => t.toLowerCase().match(/[a-z0-9']+/g) ?? []

/**
 * Does this text trail off? The strongest evidence there is that she is still
 * thinking: whisper's "…" for a sentence left in the air, a dash, or a filler.
 * These wait the longest, because a person trailing off is exactly the person
 * who pauses longest before going on.
 */
function trailsOff(text) {
  const t = text.trim()
  if (/(\.\.\.|…|[–—-])$/.test(t)) return true
  return FILLERS.has(words(t).at(-1) ?? '')
}

/** Does this text sound like she stopped mid-thought? */
function looksUnfinished(text) {
  const t = text.trim()
  if (!t) return true
  if (trailsOff(t)) return true
  // Whisper's mid-clause marks. It writes "…" for a trailed-off sentence, which
  // is exactly the case this whole file exists for.
  if (/[,;:–—-]$/.test(t)) return true
  if (/(\.\.\.|…)$/.test(t)) return true
  // A missing full stop used to be enough on its own, and it is the weakest
  // evidence here. Whisper leaves one off complete sentences routinely —
  // "Count slowly from 1 to 20" came back unpunctuated and finished, and
  // waiting on it more than doubled the time before the message went, from
  // 1.18s to 2.69s. So it only counts when something else agrees: a hanging
  // word, or an utterance short enough to be a fragment she is still building.
  const last = words(t)
  if (HANGING.has(last.at(-1) ?? '')) return true
  return !/[.!?]$/.test(t) && last.length < 4
}

/** Does this text sound like the second half of something already sent? */
function looksLikeCarryOn(text) {
  const t = text.trim()
  if (!t) return false
  // Whisper capitalises the first word of a segment, so a lowercase start is a
  // strong signal on its own.
  if (/^[a-z]/.test(t)) return true
  return CONTINUES.has(words(t)[0] ?? '')
}

// Plain ES module with no imports, so the page loads it as-is and the tests
// import the same file.
export function createTurnTaker(cfg = {}) {
  const C = { ...DEFAULTS, ...cfg }

  // These are null rather than 0 when unset. A zero timestamp is a real one —
  // the tests start their clock there — and a falsy sentinel made the first
  // tick of a session look like a continuation of nothing.
  /** When the current burst of speech began; null while quiet. */
  let speechStart = null
  /** When the current run of quiet began; null while she is speaking. The cut
   *  does not reset it — the 700ms spent proving the utterance ended is part of
   *  the silence, so the turn boundary counts from when she actually stopped. */
  let silenceSince = null

  /** The room's own level, tracked from the quietest thing recently heard.
   *  Null until the first poll, which seeds it: she is not usually mid-word at
   *  the instant she presses Talk, so the first reading is the room, and
   *  seeding means a noisy room is handled from the first sentence rather than
   *  after a few seconds of being cut off. Capped, in case she is. */
  let floorRms = null
  let floorAt = null
  /** Whether the sound now in progress has already taken the floor from the agent.
   *  One barge per burst; cleared with `speechStart`. */
  let barged = false

  let seq = 0
  /** Utterances cut in this turn, oldest first. Transcriptions can come back
   *  out of order, so the order lives here and not in arrival order. */
  let cuts = []
  const said = new Map()

  let sentAt = null
  let decayed = true
  /** The learned wait. One number, three rules: up to just past a pause she
   *  came back from, up on a send she talked through, down on a clean turn. */
  let base = C.floorMs

  /** Carried from the start of a burst to its cut, because a cough should not
   *  teach it anything. */
  let armedGap = 0
  let armedSinceSend = 0
  /** The cut whose words will say whether the last send was early, and how long
   *  after that send she started again. Judged when its words arrive. */
  let earlySeq = 0
  let earlyGap = 0

  const gathering = () => cuts.length > 0
  const waiting = () => cuts.some((s) => !said.has(s))
  const clamp = (n) => Math.max(C.floorMs, Math.min(C.adaptCeilMs, n))

  /** The fragments so far, as one thing she said. */
  function pending() {
    const parts = cuts.map((s) => (said.get(s) ?? '').trim()).filter(Boolean)
    return parts
      .map((t, i) => (i < parts.length - 1 ? t.replace(/(\.\.\.|…)$/, '').trim() : t))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** How long the current turn has to sit quiet before it goes. */
  function waitMs() {
    const t = pending()
    if (!t) return base
    if (trailsOff(t)) return C.ceilMs
    return looksUnfinished(t) ? Math.min(base * C.unfinishedFactor, C.ceilMs) : base
  }

  function clear() {
    cuts = []
    said.clear()
    earlySeq = 0
  }

  /**
   * One poll of the microphone level.
   *
   * Returns at most one of: `act` — what the recorder should do — or `send`,
   * the words of a finished turn.
   */
  function level(rms, now, opts = {}) {
    if (floorRms === null) floorRms = Math.min(rms, C.noiseCeil)
    else if (floorAt !== null && now > floorAt) {
      const climb = C.noiseRisePerSec * ((now - floorAt) / 1000)
      floorRms = Math.min(rms, floorRms + climb, C.noiseCeil)
    }
    floorAt = now
    // While the agent talks, its own voice comes back through the microphone
    // at a level the page can predict from what it is playing. Below that is
    // the agent, not her. (Unused while macOS voice processing keeps the
    // agent out of the microphone.)
    const speaking = Math.max(C.speakingRms, floorRms * C.noiseFactor, opts.echoRms ?? 0)

    if (rms > speaking) {
      if (speechStart === null) {
        speechStart = now
        armedGap = silenceSince === null ? 0 : now - silenceSince
        // Evidence about the last send, held until this burst proves it was
        // speech. Not gathered while the agent is talking: echo cancellation is good
        // but it is not proof, and a leak of its own voice would teach it that
        // she never stops.
        const sinceSend = sentAt === null ? Infinity : now - sentAt
        armedSinceSend =
          !opts.agentSpeaking && !gathering() && sinceSend <= C.continueGraceMs ? sinceSend : 0
        silenceSince = null
        return { act: 'begin' }
      }
      silenceSince = null
      // The sound has held long enough to be a person rather than a chair, so
      // the sentence the agent is part way through stops. Once per burst.
      if (opts.agentSpeaking && !barged && now - speechStart >= C.bargeMs) {
        barged = true
        return { act: 'barge' }
      }
      return {}
    }

    if (silenceSince === null) silenceSince = now

    if (speechStart !== null) {
      if (now - silenceSince < C.utteranceGapMs) return {}
      const spoke = silenceSince - speechStart
      speechStart = null
      barged = false
      if (spoke < C.minUtteranceMs) {
        armedGap = 0
        armedSinceSend = 0
        return { act: 'discard' }
      }
      // She came back inside the boundary, so the boundary was too short by
      // however much it missed by.
      if (gathering() && armedGap) base = clamp(Math.max(base, armedGap + C.marginMs))
      armedGap = 0
      const s = ++seq
      cuts.push(s)
      if (armedSinceSend) {
        earlySeq = s
        earlyGap = armedSinceSend
      }
      armedSinceSend = 0
      return { act: 'cut', seq: s }
    }

    if (!gathering()) {
      // A turn that ended and stayed ended. Let the wait relax.
      if (sentAt !== null && !decayed && now - sentAt > C.graceMs) {
        decayed = true
        base = clamp(base - C.decayMs)
      }
      return {}
    }

    const held = now - silenceSince
    if (waiting() && held < C.stuckMs) return {}
    if (held < waitMs()) return {}

    const text = pending()
    clear()
    // Everything she said transcribed to nothing — a door, or a word whisper
    // could not make out. Say so, or the screen sits on "listening" for the
    // rest of the session.
    if (!text) return { act: 'idle' }
    sentAt = now
    decayed = false
    return { send: text }
  }

  /**
   * The words of one utterance came back. `text` is null if it failed, which
   * still has to be recorded or the turn waits on it forever.
   */
  function heard(s, text) {
    if (!cuts.includes(s)) return
    said.set(s, text ?? '')
    if (s !== earlySeq) return
    earlySeq = 0
    // She started again within a second and a half of a send, or started with
    // "and". Either way the send went before she was done.
    if (earlyGap <= C.graceMs || looksLikeCarryOn(text ?? '')) base = clamp(base + C.marginMs)
  }

  return {
    level,
    heard,
    pending,
    /** Whatever was pending has been taken by something else — a manual send. */
    taken: clear,
    /** For tests and for reading the learned wait. */
    waitMs,
    baseMs: () => base,
    /** For tests. The rule it encodes is subtle and worth pinning directly:
     *  what counts as her having finished a sentence decides how long she
     *  waits for every message. */
    looksUnfinished,
    trailsOff,
  }
}

/**
 * Whether what she starts saying now is the rest of what was just sent.
 *
 * However patient the boundary is, it will sometimes guess wrong, and then the
 * agent answers half a thought: it starts replying while she is still
 * finishing, and she ends up interrupting it without meaning to. So a wrong
 * guess is undone rather than lived with: if she starts again within a few
 * seconds of a send, what she says next is joined to what was sent, and the early answer is thrown away, even if it had
 * started speaking. A real "no, stop" in that window still reaches the agent,
 * with the thought it was about.
 *
 * Bounded by time and nothing else. Something she adds a minute later, while
 * the agent works through tools, is a new instruction, not the end of a
 * sentence, and restarting the work for it would be wrong.
 *
 * Pure, and clock-driven like the turn taker.
 */
export function createCarryOn({ withinMs = 5000 } = {}) {
  let sent = null
  let carrying = ''

  return {
    /** Her words went to the agent. */
    sent(text, now) {
      sent = { text, at: now }
      carrying = ''
    },
    /** She has started making a sound. True if it carries on the last send. */
    resumed(now) {
      if (carrying) return true
      if (sent && now - sent.at <= withinMs) carrying = sent.text
      sent = null
      return Boolean(carrying)
    },
    /** It was a cough after all. */
    abandon() {
      carrying = ''
    },
    /** What to put in front of the next send, once; '' when she moved on. */
    take() {
      const t = carrying
      carrying = ''
      return t
    },
  }
}
