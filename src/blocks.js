/**
 * A reply as the blocks it is made of: paragraphs, lists, code, tables,
 * headings. The unit a reply is shaped in, because whether something should be
 * said, offered as options, or left on screen is a property of a block, not a
 * sentence: a numbered list is steps or options as a whole.
 *
 * `kind` is what the markup says; what the block is *for* is a judgement made
 * elsewhere.
 */
export function blocks(text) {
  const out = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  const push = (kind, body) => {
    const t = body.join('\n').trim()
    if (t) out.push({ kind, text: t })
  }
  const isItem = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l)
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (/^\s*```/.test(line)) {
      const body = [line]
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) body.push(lines[i++])
      push('code', body)
    } else if (/^\s*#{1,6}\s/.test(line)) {
      push('heading', [line])
      i++
    } else if (isRow(line)) {
      const body = []
      while (i < lines.length && isRow(lines[i])) body.push(lines[i++])
      push('table', body)
    } else if (isItem(line)) {
      const body = []
      // Items, and the indented or wrapped lines that belong to them.
      while (i < lines.length && (isItem(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i])))) body.push(lines[i++])
      push('list', body)
    } else {
      const body = []
      while (i < lines.length && lines[i].trim() && !isItem(lines[i]) && !isRow(lines[i]) && !/^\s*(```|#{1,6}\s)/.test(lines[i])) {
        body.push(lines[i++])
      }
      push('paragraph', body)
    }
  }
  return out
}
