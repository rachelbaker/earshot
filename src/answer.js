/**
 * Which option a spoken answer picks, or null if it picks none.
 *
 * Options are said as "Option A: …, Option B: …", so she can answer with the
 * letter, the position, or the option's own words: "B", "option b", "the
 * second one", "blue". A lone letter or number only counts in a short answer:
 * "a" is a word, and "I'd go with a mix" is not option A.
 */
const ORDINALS = { first: 0, one: 0, '1': 0, second: 1, two: 1, '2': 1, third: 2, three: 2, '3': 2, fourth: 3, four: 3, '4': 3 }

const words = (t) => t.toLowerCase().match(/[a-z0-9']+/g) ?? []

export function pickOption(said, options) {
  const w = words(said)
  if (!w.length || !options.length) return null
  const short = w.length <= 4

  // The option's own words first: "the blue one" is Blue, not the first one.
  // When the ordinal check ran first, it answered Red.
  let best = null
  let bestScore = 0
  options.forEach((o, i) => {
    const label = words(o.label).filter((x) => x.length > 2)
    if (!label.length) return
    const score = label.filter((x) => w.includes(x)).length / label.length
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  })
  if (bestScore >= 0.6) return best

  // "option b", "b", "b please"
  for (let i = 0; i < w.length; i++) {
    const letter = w[i].length === 1 ? 'abcdefgh'.indexOf(w[i]) : -1
    if (letter >= 0 && letter < options.length && (w[i - 1] === 'option' || short)) return letter
  }
  // "the second one", "number two", "option 2". "One" is only a number after
  // "option" or "number", or on its own: in "the blue one" it is not.
  for (let i = 0; i < w.length; i++) {
    const n = ORDINALS[w[i]]
    if (n === undefined || n >= options.length) continue
    const after = ['option', 'number'].includes(w[i - 1])
    if (w[i] === 'one' && !after && w.length > 1) continue
    if (after || short || w[i - 1] === 'the') return n
  }
  return null
}
