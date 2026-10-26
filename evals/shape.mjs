#!/usr/bin/env node
/**
 * Which model can tell what each block of a reply is for: TypeSafe's Jev
 * (hosted) or Gemma 4 E4B through LM Studio (local). Both are tried.
 *
 * Each non-code block of seven real agent replies (evals/replies, written
 * without earshot's listening instructions, so they are as screen-shaped as
 * replies get) is labelled by both models with one of the purposes below, and
 * scored against hand-made labels (evals/shape-labels.json) on what a
 * listener would actually hear: said, offered as options, left on screen,
 * pointed at, or dropped.
 *
 *   node evals/shape.mjs            both models
 *   node evals/shape.mjs jev        one
 *
 * The TypeSafe key is read from the macOS Keychain (service
 * "typesafe-api-key") and never printed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { blocks } from '../src/blocks.js'

const here = new URL('.', import.meta.url)
const QUESTIONS = [
  'How do I set up a Python virtual environment and install requests?',
  'I want to speed up our test suite. What are my options?',
  'Why does git rebase rewrite commit hashes?',
  'Should I use SQLite or Postgres for a small personal app?',
  'The build is failing with "Cannot find module \'zod\'". What do I do?',
  'Walk me through deploying a Cloudflare Worker for the first time.',
  "I'm about to run git push --force on main to fix my mistake. Anything I should know?",
]

/** What a block can be for, as the models are told it. */
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

/** How each purpose reaches her ears. */
const DELIVERY = {
  answer: 'say', status: 'say', recommendation: 'say', question: 'say', warning: 'say', explanation: 'say',
  options: 'options', steps: 'screen', facts: 'screen', 'lead-in': 'point', narration: 'drop', offer: 'drop',
}

function state(r, i, bs) {
  const before = bs.slice(0, i).filter((b) => b.kind !== 'code').at(-1)
  return [
    `The listener asked: ${QUESTIONS[r - 1]}`,
    before ? `The block before this one: ${before.text.slice(0, 400)}` : 'This is the first block of the reply.',
    `This block (${bs[i].kind}): ${bs[i].text.slice(0, 1200)}`,
  ].join('\n\n')
}

const INSTRUCTIONS =
  'What is this block of an assistant reply doing for the listener? The reply will be heard, not read.'

async function jev(text) {
  const key = (jev.key ??= execFileSync('security', ['find-generic-password', '-s', 'typesafe-api-key', '-w']).toString().trim())
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: text,
      model: 'jev-latest',
      questions: { purpose: { type: 'choice', instructions: INSTRUCTIONS, criteria: PURPOSES } },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`jev ${res.status}`)
  const a = (await res.json()).answers.purpose
  return { label: a.choice, confidence: a.confidence }
}

async function gemma(text) {
  const res = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemma-4-e4b',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `${INSTRUCTIONS} Answer with the one purpose that fits best:\n${Object.entries(PURPOSES)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join('\n')}`,
        },
        { role: 'user', content: text },
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
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`gemma ${res.status}`)
  const body = await res.json()
  return { label: JSON.parse(body.choices[0].message.content).purpose }
}

const labels = JSON.parse(readFileSync(new URL('shape-labels.json', here), 'utf8'))
const cases = []
for (let r = 1; r <= QUESTIONS.length; r++) {
  const bs = blocks(readFileSync(new URL(`replies/reply-${r}.md`, here), 'utf8'))
  bs.forEach((b, i) => {
    const id = `${r}.${i}`
    if (labels[id]) cases.push({ id, kind: b.kind, want: labels[id], state: state(r, i, bs) })
  })
}

const which = process.argv[2]
const models = { jev, gemma }
for (const [name, ask] of Object.entries(models)) {
  if (which && which !== name) continue
  const rows = []
  const started = Date.now()
  // Jev in parallel, as earshot would ask it; Gemma one at a time, because one
  // local model answers one request at a time anyway.
  const run = async (c) => {
    const t = Date.now()
    try {
      const got = await ask(c.state)
      rows.push({ ...c, got: got.label, ms: Date.now() - t })
    } catch (e) {
      rows.push({ ...c, got: `ERROR ${e.message}`, ms: Date.now() - t })
    }
  }
  if (name === 'jev') await Promise.all(cases.map(run))
  else for (const c of cases) await run(c)
  rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  const exact = rows.filter((r) => r.got === r.want).length
  const heard = rows.filter((r) => DELIVERY[r.got] === DELIVERY[r.want]).length
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  console.log(`\n${name}: delivery right ${heard}/${rows.length}, exact label ${exact}/${rows.length}`)
  console.log(`  per block: median ${ms[ms.length >> 1]}ms, slowest ${ms.at(-1)}ms; all ${rows.length} in ${Date.now() - started}ms`)
  for (const r of rows.filter((r) => DELIVERY[r.got] !== DELIVERY[r.want])) {
    console.log(`  ${r.id.padEnd(5)} want ${r.want} (${DELIVERY[r.want]}), got ${r.got} (${DELIVERY[r.got] ?? '?'})`)
  }
}
