/**
 * The words in what whisper printed, or nothing if there were none.
 *
 * whisper prints leading spaces and blank lines around each segment, and tags
 * anything that is not speech: [MUSIC PLAYING], [BLANK_AUDIO], (silence). Three
 * seconds of a quiet room came back as [MUSIC PLAYING], and sending that to an
 * agent would be worse than sending nothing.
 *
 * The bracketed rule is case-sensitive on purpose: whisper's tags are upper
 * case, and an `i` flag here ate "[see note]", words actually dictated.
 *
 * A whole utterance that is one bracketed tag and nothing else is caught
 * whatever its case, because that is never dictation. Once a burst of room
 * noise came back as "[explosion]", was sent as a message, ran a model
 * turn, and the agent said out loud that it could not see a request in it.
 */
export function heard(text) {
  const said = text
    .replace(/\[[A-Z_ ]+\]/g, ' ')
    .replace(/\((?:silence|music|blank[_ ]audio)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return /^[[(][^\])]*[\])][.!?]?$/.test(said) ? '' : said
}
