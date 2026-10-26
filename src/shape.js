import { blocks } from './blocks.js'
import { sentences } from './readable.js'

/**
 * A reply shaped for listening, block by block.
 *
 * Nobody can follow multi-step directions by ear, or wants to wait through
 * hearing steps they will not retain: those are for reading at the computer.
 * Choices should come as clearly lettered A/B/C options, and the listener
 * should be told when there is more detail on the screen.
 *
 * So each block of a reply is classified by what it is for (see `PURPOSES` in
 * classify.js), and delivered by that: said, offered as lettered options, or
 * left on screen with a sentence saying it is there. Code and tables never need
 * a model to know they belong on screen.
 *
 * Blocks are cut as text streams in and classified concurrently, but what comes
 * out keeps the reply's order: a block waits for the ones before it.
 *
 * Out: `say(text)` for each sentence to speak, `show({ kind, purpose, text })`
 * for each block to put on screen, in reply order.
 */

/** How each purpose reaches the listener. */
export const DELIVERY = {
  answer: 'say', status: 'say', recommendation: 'say', question: 'say', warning: 'say', explanation: 'say',
  options: 'options', steps: 'screen', facts: 'screen', 'lead-in': 'point', narration: 'drop', offer: 'drop',
}

const LETTERS = 'ABCDEFGH'

/** The items of a markdown list, as plain one-line text. */
function items(text) {
  return text
    .split('\n')
    .filter((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l))
    .map((l) => l.replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
}

/** The first sentence of a list item, readable: the label part of an option. */
function gist(item) {
  return sentences(item)[0]?.replace(/[.:]$/, '') ?? ''
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** A command too long to say: `python -c "import requests; print(…)"`. */
/** A command too long to say. Each inline span on its own: matching from one
 *  closing backtick to the next opening one read the prose between `/earshot`
 *  and `/talk` as a 30-character command. */
const longCode = (text) => [...text.matchAll(/`([^`\n]+)`/g)].some((m) => m[1].length >= 25)

/**
 * How a block reaches the listener. Plain sentences are said, always: in
 * conversation a model judging paragraphs sent "Done, /earshot now does the
 * same as /talk" to the screen as steps and dropped "Press Talk when you're
 * ready" as an offer, so the listener heard almost nothing. What is for reading is marked up as such,
 * so the markup decides: code and tables go on screen, a paragraph only when
 * it carries a command too long to say, and a list by what the model judges
 * it to be (steps on screen, options lettered, the rest said).
 */
export function deliveryOf(block, purpose) {
  if (block.kind === 'code' || block.kind === 'table') return 'screen'
  if (block.kind === 'heading') return 'drop'
  if (block.kind === 'paragraph') return longCode(block.text) ? 'screen' : 'say'
  const how = DELIVERY[purpose] ?? 'say'
  // A short list is heard, whatever it is judged to be, except steps: two
  // bullet points said "There are 2 more points on screen" while two lettered
  // paragraphs were read out; the two should be consistent. Steps still go to
  // the screen; nobody follows them by ear.
  if (how === 'screen' && purpose !== 'steps' && isShortList(block.text)) return 'say'
  return how
}

/** Up to four items, none long, and no command too long to say. */
function isShortList(text) {
  const all = items(text)
  return all.length > 0 && all.length <= 4 && all.every((it) => it.length <= 160) && !longCode(text)
}

/** What to say for a block left on screen. */
function pointer(block, purpose) {
  if (block.kind === 'paragraph' && longCode(block.text)) return "There's a command on screen."
  if (block.kind === 'code') return /```(bash|sh|zsh|shell|console)?\s*\n/.test(block.text) ? "There's a command on screen." : "There's code on screen."
  if (block.kind === 'table') return "There's a table on screen."
  const n = items(block.text).length
  if (purpose === 'steps') return n > 1 ? `There are ${plural(n, 'step', 'steps')} on screen.` : 'The details are on screen.'
  return n > 1 ? `There are ${plural(n, 'more point', 'more points')} on screen.` : 'More detail is on screen.'
}

/** Lettered options, said: "Option A, run tests in parallel. Option B, …" */
function lettered(text) {
  const all = items(text)
  const said = all.slice(0, 4).map((it, i) => `Option ${LETTERS[i]}: ${gist(it)}.`)
  if (all.length > 4) said.push(`And ${plural(all.length - 4, 'more', 'more')} on screen.`)
  return said
}

export function createShaper({ classify, onSay, onShow }) {
  let buf = ''
  /** The last block handed on, for its successor's context. */
  let previous = null
  /** Blocks in reply order, each waiting on its classification. */
  let chain = Promise.resolve()
  /** Set when she talks over the reply: nothing more of it is delivered. */
  let dropped = false
  let question = ''
  /** A pointer is said once per run of screen blocks, not once per block. */
  let lastPointer = ''

  /** A short line ending in a colon, held to see what it introduces. */
  let leadIn = null
  const isLeadIn = (block) => block.kind === 'paragraph' && /:\s*$/.test(block.text) && block.text.length <= 160

  /** Say a held lead-in after all: what followed it is being said too. */
  function releaseLeadIn() {
    if (!leadIn) return
    for (const s of sentences(leadIn.text)) onSay(s)
    leadIn = null
  }

  function deliver(block, purpose) {
    if (dropped) return
    const how = deliveryOf(block, purpose)
    // "Run these from your project folder:" before a block that goes on
    // screen is noise in the ear; the pointer says it better. Before anything
    // said, it is said as written.
    if (how === 'say' && isLeadIn(block)) {
      releaseLeadIn()
      leadIn = block
      return
    }
    if (how === 'screen' || how === 'drop' || how === 'point') {
      if (leadIn && how === 'screen') onShow({ kind: leadIn.kind, purpose: 'lead-in', text: leadIn.text })
      else releaseLeadIn()
      leadIn = null
    } else releaseLeadIn()
    if (how !== 'say') onShow({ kind: block.kind, purpose, text: block.text })
    const say = (t) => onSay(t)
    if (how === 'say') {
      lastPointer = ''
      // A list item by item, so items without a full stop do not run together.
      const parts = block.kind === 'list' ? items(block.text) : [block.text]
      for (const part of parts) for (const s of sentences(part)) say(s)
    } else if (how === 'options') {
      lastPointer = ''
      for (const s of lettered(block.text)) say(s)
    } else if (how === 'screen') {
      const p = pointer(block, purpose)
      if (p !== lastPointer) say(p)
      lastPointer = p
    }
    // 'point' and 'drop' say nothing: a lead-in's pointer is said by the block
    // it introduces.
  }

  function take(block) {
    const context = { question, previous: previous?.text ?? '', block }
    previous = block
    // Only a list needs judging; everything else is decided by its markup.
    const needsModel = block.kind === 'list'
    const purpose = needsModel ? classify(context).catch(() => fallback(block)) : Promise.resolve(block.kind)
    const prior = chain
    chain = (async () => {
      const p = await purpose
      await prior
      deliver(block, p)
    })()
  }

  /** Complete blocks out of the buffer; the last one may still be growing. */
  function cut(final) {
    const text = buf
    // A block is complete once a blank line follows it and no code fence is
    // left open. Until then it is still being written.
    const fences = (text.match(/```/g) ?? []).length
    let upto = final ? text.length : text.lastIndexOf('\n\n')
    if (!final && fences % 2) upto = Math.min(upto, text.lastIndexOf('```'))
    if (upto <= 0) return
    for (const b of blocks(text.slice(0, upto))) take(b)
    buf = text.slice(upto)
  }

  return {
    /** What she asked, for context. */
    asked(text) {
      question = text
      previous = null
      dropped = false
      lastPointer = ''
    },
    push(delta) {
      if (dropped) return
      buf += delta
      cut(false)
    },
    /** A block of reply ended: whatever is buffered is complete. */
    end() {
      if (dropped) return
      cut(true)
      buf = ''
      // A lead-in with nothing after it is just a sentence.
      chain = chain.then(() => dropped || releaseLeadIn())
    },
    drop() {
      dropped = true
      buf = ''
      leadIn = null
    },
    /** Resolves once everything handed in has been delivered. */
    settled: () => chain,
  }
}

/** Without a model, or when it fails: what the markup alone suggests. */
export function fallback(block) {
  if (block.kind === 'list') return /^\s*\d+[.)]\s+/m.test(block.text) ? 'steps' : 'facts'
  if (/:\s*$/.test(block.text) && block.text.length < 120) return 'lead-in'
  return 'answer'
}
