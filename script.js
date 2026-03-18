import { App } from "../../../../42/api/os/App.js"
import { getSortableDateTime } from "../../../../42/lib/date/getSortableDateTime.js"

const PARAMS = {
  keyFrame: true,
  speed: 3,
}

let mediaRecorder
const recordedChunks = []

const videoEl = document.querySelector("video")
const canvas = document.querySelector("canvas")

const startBtn = document.querySelector("#startBtn")

async function startWebcam() {
  startBtn.setAttribute("aria-pressed", "true")
  startBtn.style.pointerEvents = "none"
  const ctx = canvas.getContext("2d")
  const stream = await navigator.mediaDevices.getUserMedia({ video: true })
  videoEl.srcObject = stream
  const [track] = stream.getVideoTracks()
  const settings = track.getSettings()
  canvas.width = settings.width
  canvas.height = settings.height

  const encoder = new VideoEncoder({
    output: handleEncodedChunk,
    error: (err) => console.error("Encoder error:", err),
  })

  encoder.configure({
    codec: "vp8",
    width: settings.width,
    height: settings.height,
    bitrate: 1_000_000,
  })
  const decoder = new VideoDecoder({
    output: handleDecodedFrame,
    error: (err) => console.error("Decoder error:", err),
  })
  decoder.configure({ codec: "vp8" })

  function processFrame() {
    if (videoEl.readyState >= 2) {
      const frame = new VideoFrame(videoEl, {
        timestamp: performance.now() * 1000,
      })
      encoder.encode(frame, { keyFrame: PARAMS.keyFrame })
      PARAMS.keyFrame = false
      frame.close()
    }
    requestAnimationFrame(processFrame)
  }
  function handleEncodedChunk(chunk) {
    if (chunk.type === "key") {
      decoder.decode(chunk)
    } else {
      for (let i = 0; i < PARAMS.speed; i++) {
        decoder.decode(chunk)
      }
    }
  }
  function handleDecodedFrame(frame) {
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
    frame.close()
  }
  processFrame()

  function resizeCanvasToMatchVideo(canvas, video) {
    const { videoWidth } = video
    const { videoHeight } = video
    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight
    const videoRatio = videoWidth / videoHeight
    const windowRatio = windowWidth / windowHeight
    let renderWidth
    let renderHeight
    if (windowRatio > videoRatio) {
      canvas.style.width = "100%"
      canvas.style.height = "auto"
      renderHeight = windowHeight
      renderWidth = (renderHeight / videoHeight) * videoWidth
    } else {
      canvas.style.width = "auto"
      canvas.style.height = "100%"
      renderWidth = windowWidth
      renderHeight = (renderWidth / videoWidth) * videoHeight
    }
    canvas.width = renderWidth
    canvas.height = renderHeight
  }
  videoEl.addEventListener("loadedmetadata", () => {
    resizeCanvasToMatchVideo(canvas, videoEl)
  })
  window.addEventListener("resize", () => {
    resizeCanvasToMatchVideo(canvas, videoEl)
  })
  document.querySelector("#startBtn").style.display = "none"
  document.querySelector("#controls").style.display = "initial"
}

function startRecording() {
  const icon = app.getIcon("16x16")

  window.top.sys42.toast("Start recording.", {
    picto: icon,
    label: "DataMosh",
    timeout: 1500,
  })

  const stream = canvas.captureStream(30) // 30 FPS
  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "video/webm; codecs=vp9",
  })
  recordedChunks.length = 0
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recordedChunks.push(e.data)
    }
  }

  mediaRecorder.onstop = () => {
    const timeStamp = getSortableDateTime({ seconds: true })
    app.saveFileAs({
      path: undefined,
      suggestedName: `datamosh_${timeStamp}.webm`,
      startIn: "desktop",
    })

    window.top.sys42.toast("Stop Recording.", {
      picto: icon,
      label: "DataMosh",
      timeout: 3000,
    })
  }

  mediaRecorder.start()
  document.querySelector("#recordStartBtn").style.display = "none"
  document.querySelector("#recordStopBtn").style.display = "inline-block"
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop()
  }
  document.querySelector("#recordStartBtn").style.display = "inline-block"
  document.querySelector("#recordStopBtn").style.display = "none"
}

document
  .querySelector("#recordStartBtn")
  .addEventListener("click", startRecording)
document
  .querySelector("#recordStopBtn")
  .addEventListener("click", stopRecording)

document.querySelector("#startBtn").addEventListener("click", startWebcam)
document.querySelector("#keyframeBtn").addEventListener("click", () => {
  PARAMS.keyFrame = true
})
document.querySelector("#speedInput").addEventListener("input", (e) => {
  PARAMS.speed = Number.parseInt(e.target.value, 10)
})

const app = new App()
app.on("encode", () => new Blob(recordedChunks, { type: "video/webm" }))
