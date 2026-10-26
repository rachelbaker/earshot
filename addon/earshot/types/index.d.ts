declare module 'claude-code' {
  interface PluginState {
    earshot: {
      /** /talk is on in this session: replies are spoken. */
      isOn: boolean
      /** Replies are not spoken; earshot is otherwise on. */
      isMuted: boolean
      /** The microphone is on, for this one turn. */
      isMicOn: boolean
      /** What earshot is doing: mic-off, listening, hearing, thinking, speaking, asking. */
      state: string
      /** Speech to text: "apple" (macOS on-device) or "whisper". */
      stt: string
      /** What she has said so far this turn, before it is sent. */
      pending: string
    }
  }
}
