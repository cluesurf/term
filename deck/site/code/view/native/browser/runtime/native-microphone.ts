// The microphone in a browser (device-layer-0022), docked by ../microphone.tree as `<global:native-microphone>`. One
// recording from getUserMedia through a MediaRecorder (webm or ogg in Chrome and Firefox, mp4 in Safari), decoded by an
// OfflineAudioContext at 16,000 samples a second, its channels mixed to one, and written as the same 16-bit PCM WAV
// every other host writes, answered as a blob: address. The offline context is the one that needs no click: a live
// AudioContext waits on a gesture before it runs. The browser prompts for the grant itself when it has none.
//
// Every runtime a page links is joined into one module in front of the program, so nothing is named at the top level
// but the object.

export const nativeMicrophone = {
  // the one format every host writes (../../microphone.tree)
  rate: 16000,

  // `audio <blob address>`, or denied, unavailable or failed
  async record(seconds: number): Promise<string> {
    if (
      typeof document === 'undefined' ||
      typeof navigator.mediaDevices?.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined' ||
      typeof OfflineAudioContext === 'undefined'
    ) {
      return 'unavailable'
    }

    let stream: MediaStream

    try {
      // the sound as it is, as AVAudioRecorder and AudioRecord give it: a call's echo cancelling, noise suppression and
      // gain control are for a voice going out, and suppression takes a steady tone away as noise
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    } catch (error) {
      const name = (error as Error).name

      return name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : 'failed'
    }

    try {
      const recorder = new MediaRecorder(stream)
      const pieces: Blob[] = []
      recorder.addEventListener('dataavailable', event => pieces.push(event.data))
      const stopped = new Promise(settle => recorder.addEventListener('stop', settle))
      recorder.start()
      await new Promise(settle => setTimeout(settle, seconds * 1000))
      recorder.stop()
      await stopped
      const encoded = await new Blob(pieces, { type: recorder.mimeType }).arrayBuffer()
      const decoded = await new OfflineAudioContext(1, 1, nativeMicrophone.rate).decodeAudioData(encoded)

      return `audio ${URL.createObjectURL(nativeMicrophone.wave(decoded))}`
    } catch {
      return 'failed'
    } finally {
      stream.getTracks().forEach(one => one.stop())
    }
  },

  // the decoded sound as a WAV: its channels averaged into one, each sample clamped and scaled to 16 bits, behind a
  // RIFF header with a PCM `fmt ` chunk and the `data` chunk, every number little-endian
  wave(audio: AudioBuffer): Blob {
    const length = audio.length
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index))
    const out = new DataView(new ArrayBuffer(44 + length * 2))
    const ascii = (at: number, text: string) => [...text].forEach((letter, index) => out.setUint8(at + index, letter.charCodeAt(0)))
    ascii(0, 'RIFF')
    out.setUint32(4, 36 + length * 2, true)
    ascii(8, 'WAVE')
    ascii(12, 'fmt ')
    out.setUint32(16, 16, true)
    out.setUint16(20, 1, true)
    out.setUint16(22, 1, true)
    out.setUint32(24, audio.sampleRate, true)
    out.setUint32(28, audio.sampleRate * 2, true)
    out.setUint16(32, 2, true)
    out.setUint16(34, 16, true)
    ascii(36, 'data')
    out.setUint32(40, length * 2, true)

    for (let index = 0; index < length; index++) {
      const mixed = channels.reduce((sum, channel) => sum + channel[index]!, 0) / Math.max(1, channels.length)
      const held = Math.max(-1, Math.min(1, mixed))
      out.setInt16(44 + index * 2, held < 0 ? held * 0x8000 : held * 0x7fff, true)
    }

    return new Blob([out.buffer], { type: 'audio/wav' })
  },
}
