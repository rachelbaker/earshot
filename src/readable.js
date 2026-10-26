/**
 * Turning an agent's reply into something to listen to.
 *
 * The speaking itself is not here: this is only the text, so it is the same in
 * the page and in the tests.
 */

/**
 * A sentence has a word in it. The list marker "1." and the "e.g." in the
 * middle of one both end in a full stop and neither is the end of anything.
 */
const isSentence = (text) => /[A-Za-z]{2}/.test(text)

/**
 * What a reply sounds like when it is read rather than looked at.
 *
 * Agents write for a screen — backticks, bullets, headings, links, fenced
 * code. Read literally that is "backtick date backtick printed colon", and a
 * URL is thirty seconds of letters. Code blocks are dropped entirely rather
 * than summarised: the user is looking at the same screen, and a spoken function
 * body is noise in both directions. A table is the same argument again — six
 * cells read as a run-on sentence is worse than not hearing it, because it
 * has to be listened through before it can be dismissed.
 */
export function readable(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/g, 'a link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?]|$)/g, '$1$2')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^[\s|:-]+$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Where the first finished sentence in `text` ends, or 0 for none. */
export function firstSentenceEnd(text) {
  const marks = /([.!?…]["'”’)\]]?)(\s|$)/g
  for (let m = marks.exec(text); m; m = marks.exec(text)) {
    const end = m.index + m[0].length
    if (isSentence(text.slice(0, end))) return end
  }
  return 0
}

/**
 * Where streamed `text` can be cut into pieces safe to speak, oldest first.
 *
 * After each finished sentence, and at a blank line, since a heading and a
 * bullet are both spoken and neither ends in a full stop. Mid-stream a full
 * stop has to be followed by a space to count: "version 3." is the start of
 * "version 3.14" until the next delta says otherwise. Never inside a code
 * fence that has opened and not closed, because nothing inside one is said;
 * a fence that has closed is a cut of its own, so the block goes as one piece.
 */
function cuts(text) {
  const fences = [...text.matchAll(/```/g)]
  const open = fences.length % 2 ? fences.at(-1).index : Infinity
  const at = []
  let last = 0
  const marks = /([.!?…]["'”’)\]]?)\s|\n\n|```/g
  for (let m = marks.exec(text); m && m.index < open; m = marks.exec(text)) {
    const end = m.index + m[0].length
    const piece = text.slice(last, end)
    // Inside a closed fence, only its closing marks count.
    const inFence = (text.slice(0, m.index).match(/```/g) ?? []).length % 2 === 1
    if (inFence && m[0] !== '```') continue
    if (m[0] === '```' && !inFence) continue
    if (m[0] === '```' || m[0] === '\n\n' || isSentence(piece)) {
      at.push(end)
      last = end
    }
  }
  return at
}

/**
 * Sentences out of a reply that is still being written.
 *
 * `push` each delta as it arrives and `onSentence` is called once per sentence
 * the moment it is finished, already readable. `end` says the rest. The CLI
 * holds a whole message for about a second before handing over a block, so
 * speaking from deltas rather than blocks is a second off every
 * reply.
 *
 * Each chunk is made readable on its own, so a sentence already said is never
 * reconsidered when more arrives after it.
 */
export function createSentenceStream(onSentence) {
  let buf = ''
  const flush = (text) => {
    for (const s of sentences(text)) onSentence(s)
  }
  return {
    push(delta) {
      buf += delta
      let from = 0
      for (const end of cuts(buf)) {
        flush(buf.slice(from, end))
        from = end
      }
      buf = buf.slice(from)
    },
    end() {
      flush(buf)
      buf = ''
    },
    /** Forget what has not been said yet: she talked over it. */
    drop() {
      buf = ''
    },
  }
}

/**
 * A reply as the sentences it will be spoken in, oldest first.
 *
 * A sentence at a time rather than a paragraph because that is the unit a
 * cancel works on: cutting in on a paragraph means listening to the rest of
 * the sentence she interrupted.
 */
export function sentences(text) {
  const parts = []
  let rest = readable(text)
  for (let end = firstSentenceEnd(rest); end; end = firstSentenceEnd(rest)) {
    const part = rest.slice(0, end).trim()
    if (part) parts.push(part)
    rest = rest.slice(end)
  }
  if (rest.trim()) parts.push(rest.trim())
  return parts
}
