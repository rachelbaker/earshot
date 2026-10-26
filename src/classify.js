import { execFileSync } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * What a block of a reply is for, judged by a model.
 *
 * Two, one hosted and one local: TypeSafe's Jev, and Gemma 4 E4B through LM
 * Studio on this Mac. Both are optional experiments; markup rules are the
 * default. When Jev is selected and LM Studio is running, Gemma answers
 * alongside it for comparison, without deciding what is spoken.
 */

export const PURPOSES = {
  answer: 'The direct answer to what the listener asked, or the main point.',
  status: 'A report of a result or of what the assistant found, did, or could not do.',
  recommendation: 'Advice: the option the assistant recommends, or what the listener should prefer.',
  question: 'Asks the listener for information or a decision.',
  warning: 'A risk or danger the listener must know about before acting.',
  explanation: 'Reasoning about why or how something works.',
  steps: 'Actions for the listener to carry out, such as instructions, commands to run, or a procedure.',
  options: 'Alternatives the listener is being offered to choose between.',
  facts: 'A list of points, reasons, notes, conditions or reference details that are not steps or choices.',
  'lead-in': 'A short line that only introduces what comes next, like "Run these:" or "Notes:".',
  narration: 'The assistant describing what it is doing or about to do.',
  offer: 'An offer of further help, or a request for more context to give a better answer.',
}

const INSTRUCTIONS = 'What is this block of an assistant reply doing for the listener? The reply will be heard, not read.'

/** The question and its surroundings, as the model reads it. */
function stateFor({ question, previous, block }) {
  return [
    question ? `The listener said: ${question.slice(0, 600)}` : '',
    previous ? `The block before this one: ${previous.slice(0, 400)}` : 'This is the first block of the reply.',
    `This block (${block.kind}): ${block.text.slice(0, 1200)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The TypeSafe key: $TYPESAFE_API_KEY, or the macOS Keychain item
 * "typesafe-api-key". Read when first needed and never logged. Without one,
 * every list falls back to the markup rules, and that is said once.
 */
function typesafeKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'typesafe-api-key', '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

let warnedNoKey = false

export function jev({ timeoutMs = 3000 } = {}) {
  let key = null
  return async (context) => {
    key ??= typesafeKey()
    if (!key) {
      if (!warnedNoKey) console.error('earshot: no TypeSafe key (TYPESAFE_API_KEY or Keychain "typesafe-api-key"); lists are shaped by their markup instead.')
      warnedNoKey = true
      throw new Error('no TypeSafe key')
    }
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: stateFor(context),
        model: 'jev-latest',
        questions: { purpose: { type: 'choice', instructions: INSTRUCTIONS, criteria: PURPOSES } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`jev ${res.status}`)
    const a = (await res.json()).answers?.purpose
    if (!PURPOSES[a?.choice]) throw new Error('jev gave no purpose')
    return a.choice
  }
}

export function gemma({ model = 'google/gemma-4-e4b', url = 'http://localhost:1234/v1/chat/completions', timeoutMs = 30_000 } = {}) {
  return async (context) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `${INSTRUCTIONS} Answer with the one purpose that fits best:\n${Object.entries(PURPOSES)
              .map(([k, v]) => `- ${k}: ${v}`)
              .join('\n')}`,
          },
          { role: 'user', content: stateFor(context) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'purpose',
            strict: true,
            schema: {
              type: 'object',
              properties: { purpose: { type: 'string', enum: Object.keys(PURPOSES) } },
              required: ['purpose'],
            },
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`gemma ${res.status}`)
    const purpose = JSON.parse((await res.json()).choices[0].message.content).purpose
    if (!PURPOSES[purpose]) throw new Error('gemma gave no purpose')
    return purpose
  }
}

/** Where every block's labels go, to compare the models in real use. Local
 *  only; it holds her conversation. */
export const LOG = join(homedir(), '.local', 'state', 'earshot', 'shape.jsonl')

/**
 * The classifier earshot uses: `primary` decides, `shadow` (if any) is asked
 * the same thing and only logged. A shadow that is slow never holds up a reply.
 */
export function withShadow({ primary, primaryName, shadow, shadowName, log = LOG }) {
  return async (context) => {
    const started = Date.now()
    const row = { at: new Date().toISOString(), kind: context.block.kind, text: context.block.text.slice(0, 600), question: context.question?.slice(0, 200) }
    const shadowed = shadow
      ? shadow(context).then(
          (p) => ({ purpose: p, ms: Date.now() - started }),
          (e) => ({ error: e.message, ms: Date.now() - started }),
        )
      : null
    let decided
    try {
      decided = { purpose: await primary(context), ms: Date.now() - started }
    } catch (e) {
      decided = { error: e.message, ms: Date.now() - started }
    }
    void (async () => {
      row[primaryName] = decided
      if (shadowed) row[shadowName] = await shadowed
      await mkdir(dirname(log), { recursive: true })
      await appendFile(log, JSON.stringify(row) + '\n')
    })().catch(() => {})
    if (decided.error) throw new Error(decided.error)
    return decided.purpose
  }
}

/**
 * The classifier for `--shape`, and a line saying what it sends where.
 *
 * Only `jev` sends anything off this Mac: each reply block, the block before
 * it and up to 600 characters of what the user said go to TypeSafe. `gemma` and
 * `rules` keep everything local. The comparison log only ever adds the local
 * model alongside: an earlier version also ran Jev alongside Gemma, so
 * choosing the local model still sent the conversation out.
 */
export async function chooseClassifier(shape) {
  if (shape === 'rules') return { classify: undefined, about: 'replies shaped by their markup only; nothing leaves this Mac' }
  if (shape === 'gemma') {
    return { classify: withShadow({ primary: gemma(), primaryName: 'gemma' }), about: `replies shaped by Gemma (local); logged to ${LOG}` }
  }
  if (shape === 'jev') {
    const lmStudioUp = await fetch('http://localhost:1234/v1/models', { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    )
    return {
      classify: withShadow({ primary: jev(), primaryName: 'jev', shadow: lmStudioUp ? gemma() : null, shadowName: 'gemma' }),
      about: `replies shaped by Jev: reply text is sent to TypeSafe${lmStudioUp ? '; Gemma (local) compared alongside' : ''}; logged to ${LOG}`,
    }
  }
  throw new Error(`--shape is jev, gemma or rules, not "${shape}".`)
}
