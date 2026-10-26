/**
 * What earshot tells the agent, beyond what she said: how to answer when the
 * answer is heard, and what she actually heard of the last reply.
 *
 * The agent knows what it wrote, not where she stopped listening; an agent
 * that was interrupted may not remember its reply at all (Codex forgot one it
 * was cut off in). So a message that follows a cut-in starts by saying so.
 */

/** How to answer when the answer is heard rather than read. */
export const LISTENING = [
  'You are in a spoken conversation. Your replies are heard through text-to-speech, and her messages are her speech transcribed, so expect the odd misheard word.',
  'Lead with the answer, in short, plain sentences.',
  'Put steps in numbered lists, and commands, code and paths in fenced code blocks. Those stay on screen, with a spoken sentence pointing to them. Long lists also stay on screen. Say the gist in a sentence before the detail.',
  'When she has to choose, use your tool for asking the user a question if you have one; otherwise give at most four options as a list, one short line each.',
  'When you have done work, say what changed and what needs her, in a sentence or two.',
].join(' ')

export function heardNote(heard) {
  if (!heard?.cut) return ''
  if (!heard.last) return '(She cut in before hearing any of your last reply.)'
  return `(She cut in on your last reply. The last thing she heard you say was: "${heard.last}" Nothing after that reached her.)`
}

/** Said to the agent when a send went before she had finished. */
export const CONTINUES_NOTE =
  '(She had not finished when you started answering, so that answer was stopped before she heard it. Here is all of what she said:)'
