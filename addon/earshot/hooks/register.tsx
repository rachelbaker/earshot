import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

/**
 * /talk: hear this session's replies, and talk back one turn at a time.
 * Voice is part of the session itself, switched on and off per session.
 *
 * /talk turns speech on. The microphone is a separate, deliberate step: a band
 * above the prompt has a Talk button (0 in an empty prompt), and it listens for
 * one turn, then turns itself off. A microphone that is always on keeps
 * listening to everything else in the room, and someone may want to hear the
 * replies before they are ready to answer.
 *
 * This is glue. The sound is `earshot talk`, started here: microphone (macOS
 * voice processing, so the agent does not hear itself), whisper, deciding
 * when the user has finished, shaping replies for listening, speaking them.
 * This module tells it what the session writes and puts what the user says
 * into the session as their own words.
 *
 * Cutting in is `$.turn.abort` then `$.prompt.submit`: a plugin's prompt sent
 * mid-reply only queues behind it (measured).
 */

/** How to answer while the user is listening rather than reading. Matches
 *  earshot's LISTENING (src/notes.js). */
const LISTENING = [
  'Voice is on for this session: your replies are heard through text-to-speech, and some of her messages are her speech transcribed, so expect the odd misheard word.',
  'Lead with the answer, in short, plain sentences.',
  'Put steps in numbered lists, and commands, code and paths in fenced code blocks. Those stay on screen, with a spoken sentence pointing to them. Long lists also stay on screen. Say the gist in a sentence before the detail.',
  'When she has to choose, use AskUserQuestion.',
  'When you have done work, say what changed and what needs her, in a sentence or two.',
].join(' ')

const LABEL: Record<string, string> = {
  'mic-off': 'speaking replies; mic off',
  listening: 'listening',
  hearing: 'hearing you',
  thinking: 'thinking',
  speaking: 'speaking',
  asking: 'waiting for your answer',
}

const isOnAtom = atom({ plugin: 'earshot', key: 'isOn' } as const, false)
const isMicOnAtom = atom({ plugin: 'earshot', key: 'isMicOn' } as const, false)
const isMutedAtom = atom({ plugin: 'earshot', key: 'isMuted' } as const, false)
const stateAtom = atom({ plugin: 'earshot', key: 'state' } as const, 'mic-off')
const pendingAtom = atom({ plugin: 'earshot', key: 'pending' } as const, '')
const sttAtom = atom({ plugin: 'earshot', key: 'stt' } as const, 'apple')

let isOn = false
let isMicOn = false
let socket = ''
let cwd = ''
/** The running `earshot talk`, ended by returning its stream. */
let child: { return?: (v?: unknown) => unknown } | null = null
let seq = 0
let turnId: string | undefined
let running = false
/** Set while earshot is being restarted on purpose, e.g. to switch engines. */
let switching = false

/**
 * What the hooks have for earshot, sent by one sender that lives as long as
 * /talk (started in command.run below). Not posted from the hooks
 * themselves: once a reply with a long code block went silent, and
 * every reply after it, because posts were fired from the streaming hook
 * without waiting, and one went missing; earshot held everything after the
 * gap. One sender, one post at a time, consecutive text merged.
 */
const outbox: { route: string; body: Record<string, unknown> }[] = []
let wake: (() => void) | null = null
const send = (route: string, body: Record<string, unknown> = {}) => {
  if (!isOn) return
  outbox.push({ route, body })
  wake?.()
}

/**
 * Start talk: earshot, and the sender that feeds it. From /talk, and again by
 * itself when the add-on reloads with talk on: a reload restarts this module,
 * which stops the earshot it started, while the band's saved state still said
 * talk was on, so the Talk button and a sent "0" did nothing.
 */
async function startTalk($: EngineInterface) {
  isOn = true
  isMicOn = false
  seq = 0
  outbox.length = 0
  socket = `/tmp/earshot-talk-${Date.now()}.sock`
  await update($, isOnAtom, () => true)
  await update($, isMicOnAtom, () => false)
  await update($, stateAtom, () => 'mic-off')
  await update($, pendingAtom, () => '')
  void (async () => {
    // earshot restarts itself when its own code changes (and could crash);
    // while /talk is on, a new one is started in its place. Three quick
    // failures in a row means something is wrong: stop and say so.
    let quickFailures = 0
    while (isOn) {
      const startedAt = Date.now()
      seq = 0
      // Marketplace installs include the whole repo at the plugin root.
      // Keep the nested entry point working for existing local installs.
      // Use a login shell so node and whisper-cli are found.
      // EARSHOT_MIC_IDLE (seconds), if set, tunes how long the mic waits.
      const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
      const cli = `${$.plugin.root}/src/cli.js`
      const localCli = `${$.plugin.root}/../../src/cli.js`
      const stt = await read($, sttAtom)
      const muted = (await read($, isMutedAtom)) ? ' --muted' : ''
      const args = `talk --socket ${q(socket)} --cwd ${q(cwd)} --stt ${q(stt)}${muted} \${EARSHOT_MIC_IDLE:+--mic-idle "$EARSHOT_MIC_IDLE"}`
      const stream = $.process.spawn({
        argv: ['/bin/zsh', '-lc', `if [ -f ${q(cli)} ]; then exec node ${q(cli)} ${args}; elif [ -f ${q(localCli)} ]; then exec node ${q(localCli)} ${args}; else echo 'earshot: voice code is missing. Reinstall earshot from its marketplace.' >&2; exit 2; fi`],
        cwd: cwd || undefined,
      })
      child = stream as unknown as { return?: (v?: unknown) => unknown }
      let buf = ''
      let restarting = false
      try {
        for await (const piece of stream) {
          if (piece.stream === 'stderr') {
            $.ui.log(`talk: ${piece.text.trim()}`, { to: 'debug' })
            continue
          }
          buf += piece.text
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (!line) continue
            let msg: { submit?: { text: string; abort: boolean }; state?: string; pending?: string; mic?: boolean; restart?: boolean; log?: string }
            try {
              msg = JSON.parse(line)
            } catch {
              continue
            }
            if (msg.restart) restarting = true
            if (msg.state) await update($, stateAtom, () => msg.state!)
            if (msg.pending !== undefined) await update($, pendingAtom, () => msg.pending!)
            if (msg.mic !== undefined) {
              isMicOn = msg.mic
              await update($, isMicOnAtom, () => msg.mic!)
            }
            if (msg.log) $.ui.log(`talk: ${msg.log}`, { to: 'debug' })
            if (msg.submit) {
              // Cutting in: the reply stops, then her words go in as hers.
              if (msg.submit.abort && running && turnId) await $.turn.abort({ turnId })
              await $.prompt.submit({ text: msg.submit.text, asUser: true })
            }
          }
        }
      } catch (err) {
        $.ui.log(`talk: earshot stopped: ${String(err)}`, { to: 'debug' })
      }
      if (!isOn) break
      isMicOn = false
      await update($, isMicOnAtom, () => false)
      await update($, stateAtom, () => 'mic-off')
      if (restarting || switching || Date.now() - startedAt > 10_000) quickFailures = 0
      else quickFailures++
      switching = false
      if (quickFailures >= 3) {
        isOn = false
        await update($, isOnAtom, () => false)
        $.ui.toast('earshot stopped: it keeps failing to start. Type /earshot to try again.')
        break
      }
      await $.clock.sleep(300)
    }
  })()
  void (async () => {
    while (isOn) {
      if (!outbox.length) {
        await new Promise<void>((resolve) => (wake = resolve))
        wake = null
        continue
      }
      const m = outbox.shift()!
      // Text that piled up while the last post was in flight goes as one.
      if (m.route === 'text') {
        let text = String(m.body.text ?? '')
        while (outbox[0]?.route === 'text') text += String(outbox.shift()!.body.text ?? '')
        m.body = { text }
      }
      try {
        await $.http.fetch(`http://earshot/${m.route}`, {
          method: 'POST',
          body: JSON.stringify({ ...m.body, seq: seq++ }),
          socketPath: socket,
        })
      } catch (err) {
        $.ui.log(`talk: ${m.route} did not reach earshot: ${String(err)}`, { to: 'debug' })
      }
    }
  })()
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = (e as { cwd?: string }).cwd ?? ''
    await $.command.register({ name: 'talk', description: 'Turn earshot on or off: hear replies out loud, and talk back with the mic button' })
    // The same, under the tool's own name, which is easier to remember than
    // "talk".
    await $.command.register({ name: 'earshot', description: 'Turn earshot on or off: hear replies out loud, and talk back with the mic button' })
    // Talk was on before this module was reloaded: carry on, mic off.
    if (!isOn && (await read($, isOnAtom))) await startTalk($)
    return started
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'talk' && e.command !== 'earshot') return next(e)
    // "/earshot whisper" or "/earshot apple": switch speech to text, and turn
    // earshot on if it isn't, rather than toggling it off.
    const engine = e.args.trim().toLowerCase()
    if (engine === 'whisper' || engine === 'apple') {
      await update($, sttAtom, () => engine)
      if (isOn) {
        switching = true
        void child?.return?.()
        return { text: `earshot is switching to ${engine === 'apple' ? 'macOS on-device' : 'whisper'} speech recognition.` }
      }
      await startTalk($)
      return { text: `earshot is on, with ${engine === 'apple' ? 'macOS on-device' : 'whisper'} speech recognition. Talk (or send 0) to answer out loud, Mute (9) to silence replies.` }
    }
    if (isOn) {
      isOn = false
      isMicOn = false
      outbox.length = 0
      wake?.()
      void child?.return?.()
      child = null
      await update($, isOnAtom, () => false)
      await update($, isMicOnAtom, () => false)
      return { text: 'earshot is off: no spoken replies, no mic.' }
    }
    await startTalk($)
    return { text: 'earshot is on: replies are spoken. Talk (or send 0) to answer out loud, Mute (9) to silence replies, /earshot to turn it all off.' }
  })

  // The band above the prompt: the mic button, what is happening, and a way
  // to stop the voice without typing. Mic state is on the button; speech
  // state in the words beside it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOnAtom))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const micOn = await read($, isMicOnAtom)
    const state = await read($, stateAtom)
    const pending = await read($, pendingAtom)
    const muted = await read($, isMutedAtom)
    const status =
      state === 'speaking'
        ? '🔊 Speaking…'
        : state === 'thinking'
          ? 'Thinking…'
          : state === 'asking'
            ? 'Question: answer with A, B or C'
            : micOn && pending
              ? `“${pending}”`
              : micOn
                ? 'Listening…'
                : muted
                  ? '🔇 Replies are muted'
                  : '🔊 Replies are spoken'
    return (
      <Box>
        <Button
          key="mic"
          hotkey="0"
          variant={micOn ? 'primary' : 'secondary'}
          label={micOn ? '● Listening' : '🎙 Talk'}
          onPress={async () => {
            const turnOn = !micOn
            // In earshot's log, so a press that changes nothing can be told
            // from one that never arrived (0 has seemed to do nothing).
            send('note', { text: `Talk button pressed (mic ${turnOn ? 'on' : 'off'}; talk ${isOn ? 'on' : 'off in this module'})` })
            isMicOn = turnOn
            await update($, isMicOnAtom, () => turnOn)
            send('mic', { on: turnOn })
          }}
        />
        <Text color={micOn ? 'red' : undefined} dimColor={!micOn} wrap="truncate-end">
          {' '}
          {status}{' '}
        </Text>
        <Button
          key="mute"
          hotkey="9"
          label={muted ? 'Unmute' : 'Mute'}
          onPress={async () => {
            const turnOn = !muted
            await update($, isMutedAtom, () => turnOn)
            send('mute', { on: turnOn })
          }}
        />
      </Box>
    )
  })

  // A message she typed: what is still being spoken answers something older.
  // Except a lone "0": that is the Talk button. The button's own 0 shortcut
  // only works in the terminal (a bare digit in an empty prompt presses a band
  // button there; the desktop app draws a native button instead), so in the
  // desktop app "0" then Enter toggles the mic, and never reaches the agent.
  on('prompt.submit', async ($, e, next) => {
    const fromHer = (e as { origin?: { kind?: string } }).origin?.kind !== 'plugin'
    if (isOn && fromHer && e.text.trim() === '0') {
      const turnOn = !isMicOn
      isMicOn = turnOn
      await update($, isMicOnAtom, () => turnOn)
      send('mic', { on: turnOn })
      return { drop: turnOn ? '🎙️ earshot is listening. Speak.' : 'earshot stopped listening.' }
    }
    if (fromHer) send('typed')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    turnId = r.turnId
    running = true
    send('turn-start')
    return r
  })

  on('turn.step', async function* ($, e, next) {
    for await (const chunk of next(e)) {
      if (chunk.kind === 'text') send('text', { text: chunk.text })
      // A tool call ends the text before it: say its last sentence now, not
      // after the tool has run.
      else if (chunk.kind === 'tool') send('text-end')
      yield chunk
    }
    send('text-end')
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    running = false
    send('turn-end', { reason: e.reason })
    return r
  })

  // The agent's own question, answered by voice while the mic is on; with the
  // mic off she answers on screen as usual.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!isOn || !isMicOn || (await read($, isMutedAtom))) return next(e)
    const input = e.input as { questions?: { question: string; options?: { label: string }[] }[] }
    const questions = input.questions ?? []
    let answers: string[]
    try {
      const res = await $.http.fetch('http://earshot/ask', { method: 'POST', body: JSON.stringify({ questions }), socketPath: socket })
      answers = (JSON.parse(res.text) as { answers: string[] }).answers
    } catch {
      // earshot is not answering: the question goes on screen as usual.
      return next(e)
    }
    const byQuestion = Object.fromEntries(questions.map((q, i) => [q.question, answers[i] ?? '']))
    return next({ ...e, input: { ...input, answers: byQuestion } })
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!isOn) return r
    return { ...r, sections: [...r.sections, { id: 'earshot:listening', text: LISTENING, scope: 'session' as const }] }
  })
}
