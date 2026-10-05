// The camera in a browser (device-layer-0003), docked by ../camera.tree as `<global:native-camera>`. One frame from
// getUserMedia drawn onto a canvas and made a JPEG, answered as a blob: address the page can show or upload. The
// browser prompts for the grant itself when it has none.

export const nativeCamera = {
  // `photo <blob address>`, or denied, unavailable or failed
  async capture(): Promise<string> {
    if (typeof document === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return 'unavailable'
    }

    let stream: MediaStream

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true })
    } catch (error) {
      const name = (error as Error).name

      return name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : 'failed'
    }

    try {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      await video.play()
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')?.drawImage(video, 0, 0)
      const blob = await new Promise<Blob | null>(settle => canvas.toBlob(settle, 'image/jpeg', 0.9))

      return blob ? `photo ${URL.createObjectURL(blob)}` : 'failed'
    } catch {
      return 'failed'
    } finally {
      stream.getTracks().forEach(one => one.stop())
    }
  },
}
