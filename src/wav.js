/**
 * Microphone samples to the WAV whisper reads: 16 kHz, mono, 16-bit. Written
 * in memory from the raw samples, so no conversion process runs per
 * utterance.
 */

export const WHISPER_RATE = 16000

/**
 * Down to `to` Hz by averaging each output sample's span of input. Averaging
 * rather than picking is a crude low-pass filter, which is enough for speech
 * going to a model trained on 16 kHz audio.
 */
export function downsample(samples, from, to = WHISPER_RATE) {
  if (from === to) return Float32Array.from(samples)
  if (from < to) throw new Error(`cannot upsample ${from} Hz to ${to} Hz`)
  const ratio = from / to
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += samples[j]
    out[i] = sum / Math.max(1, end - start)
  }
  return out
}

/** Float samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples, rate = WHISPER_RATE) {
  const bytes = samples.length * 2
  const buf = new ArrayBuffer(44 + bytes)
  const v = new DataView(buf)
  const ascii = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + bytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, bytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}
