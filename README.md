# earshot

earshot adds voice to your existing Claude Code session on macOS. Speak instead of typing, hear Claude's replies, and interrupt a spoken reply to answer or correct it.

Turn it on with `/earshot`. A bar above the prompt gives you a Talk button, a Mute button, and the current voice status. The microphone starts off. You turn it on for each turn, and earshot sends your words when it detects that you have finished.

Replies are shaped for listening. Code, tables, numbered instructions, and long lists stay on screen, with a spoken sentence pointing you to them. Short bullet lists are read aloud. List handling follows Markdown structure, so formatting affects what you hear.

## Requirements

- macOS 26 or later for the default Apple speech recognizer.
- Node.js 22 or later, available on your PATH.
- Apple Command Line Tools or Xcode with a macOS 26 or later SDK. earshot compiles its two Swift helpers on first use.
- Claude Code with [mods support](https://code.claude.com/docs/en/plugins/mods/overview).

If you need Apple's Command Line Tools, install them in Terminal:

```sh
xcode-select --install
```

Whisper is an optional speech recognizer. You do not need Homebrew, Whisper, an API key, or a separate language model server for the default setup.

## Install

Add the marketplace in Terminal:

```sh
claude plugin marketplace add rachelbaker/earshot
```

Install the plugin:

```sh
claude plugin install earshot@earshot
```

Start a Claude Code session, then enter:

```text
/earshot
```

The first start compiles the audio helpers. macOS may also download its speech model. Allow microphone access when macOS asks. The microphone stays off until you press Talk.

## Talk and listen

- Press **Talk** to turn on the microphone. In the terminal, **0** in an empty prompt also toggles it. You can also send `0` as a message.
- Speak, then pause. earshot transcribes your speech and submits it as your message. The microphone turns off after a short window for continuing the same thought.
- If you do not start speaking, the microphone turns off after 20 seconds.
- To interrupt a spoken reply, turn on the microphone and speak.
- Press **Mute** to stop spoken replies while keeping earshot available. Press **Unmute** to hear replies again.
- Enter `/earshot` again to turn off both spoken replies and the microphone. `/talk` is an alias.

## Local processing and logs

Speech recognition, speech synthesis, and the default reply shaping run on your Mac. Your transcript becomes a normal Claude Code message and follows your Claude Code service configuration.

earshot saves transcripts and spoken reply text to `~/.local/state/earshot/talk.log`. These logs remain until you delete them. Temporary audio files are removed after use or normal shutdown. Compiled helpers are cached in `~/.cache/earshot/`.

Experimental reply classifiers are opt-in through the voice CLI. `--shape jev` sends conversation excerpts to TypeSafe. The plugin uses local rules by default.

## Check setup

From a copy of this repository, run:

```sh
npm run doctor
```

The check reports missing prerequisites without opening the microphone, compiling helpers, or downloading models. It does not test microphone permissions or speech recognition quality.

## License

[MIT](LICENSE).
