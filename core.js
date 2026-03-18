/* eslint-disable complexity */

void (() => {
  const { currentScript } = document

  // realm name must always be defined by the system
  if (currentScript) window.name = ""

  const prevent = (e) => e.preventDefault()
  const noopResolve = () => Promise.resolve()

  function getDesktopRealm() {
    /** @type {Window} */
    let realm = window

    while (realm !== window.top) {
      if (realm.name === "desktop") break
      realm = realm.parent
    }

    return realm
  }

  const uid = () =>
    String.fromCodePoint(97 + ~~(Math.random() * 26)) +
    Math.random().toString(16).slice(2, 11).padEnd(9, "0")

  function core() {
    let options = {}

    if (currentScript?.dataset.options) {
      const string = currentScript.dataset.options

      try {
        options = JSON.parse(string)
      } catch {
        for (const item of string
          .replace(/^\s*{\s*/, "")
          .replace(/\s*}\s*$/, "")
          .split(",")) {
          const [key, value] = item.split(":")
          try {
            options[key.trim()] = JSON.parse(value.trim())
          } catch {}
        }
      }
    }

    if (options.skipCommon !== true) {
      const commonScript = document.createElement("script")
      commonScript.type = "module"
      commonScript.src = "/42/api/gui/common.js"
      document.head.append(commonScript)
    }

    /* MARK: inIframe
    ================= */

    const inOpaqueOrigin = globalThis.origin === "null"
    const inDesktopRealm =
      globalThis.window !== undefined &&
      (globalThis.window === globalThis.top ||
        globalThis.window.name === "desktop")

    if (!inDesktopRealm) {
      if (window.frameElement) {
        document.documentElement.classList.toggle(
          "clear",
          Boolean(window.frameElement.closest(".clear")),
        )
      }

      document.documentElement.classList.add("in-iframe")
    }

    /* MARK: Prevent drop
    ===================== */

    window.addEventListener("dragover", prevent)
    window.addEventListener("drop", prevent)

    /* MARK: Auto Resume AudioContext
    ================================= */

    options.autoResume ??= "Start audio"

    if (inOpaqueOrigin) {
      console.warn("Impossible to connect audio to mixer in sandboxed iframe")
      return
    }

    let mainAudioContext
    let mediaAudioContext

    const desktopRealm = getDesktopRealm()

    if (!inDesktopRealm) {
      for (const key of [
        "AudioContext",
        "AudioParam",
        "AudioNode",
        "AudioBuffer",
        // TODO: proxy more audio nodes
      ]) {
        window[key] = desktopRealm[key]
      }
    }

    // @ts-ignore
    desktopRealm.sys42 ??= {}

    // @ts-ignore
    const system = desktopRealm.sys42

    system.mixer ??= {}
    system.mixer.NativeAudioContext ??= window.AudioContext
    system.mixer.contexts ??= []
    system.mixer.outputs ??= []
    system.mixer.mediaWeakMap ??= new WeakMap()

    // @ts-ignore
    const getMixer = () => desktopRealm.sys42.mixer

    system.mixer.createAudioContext ??= (trackOptions = {}) => {
      trackOptions.id ??= uid()
      trackOptions.args ??= []

      const mixer = getMixer()
      const audioContext = new mixer.NativeAudioContext(...trackOptions.args)
      if (audioContext.state !== "running") {
        addPlayToStart(trackOptions.autoResume)
      }

      mixer.contexts.push(audioContext)

      /* MARK: Media Node
      ------------------- */

      const NativeMediaElementAudioSourceNode =
        window.MediaElementAudioSourceNode

      // TODO: also add proxy for MediaElementAudioSourceNode constructor

      Object.defineProperty(audioContext, "createMediaElementSource", {
        value: (mediaEl) => {
          if (mixer.mediaWeakMap.has(mediaEl)) {
            const source = mixer.mediaWeakMap.get(mediaEl)
            if (source.context === audioContext) {
              source.disconnect()
              return source
            }

            // Prevent "already connected previously" error
            // by faking a MediaElementAudioSourceNode with a MediaStreamAudioSourceNode
            const bridgeInput = new MediaStreamAudioDestinationNode(
              source.context,
            )
            const bridgeOutput = new MediaStreamAudioSourceNode(audioContext, {
              mediaStream: bridgeInput.stream,
            })
            source.disconnect()
            source.connect(bridgeInput)
            Object.defineProperty(bridgeOutput, "mediaElement", {
              value: mediaEl,
            })

            for (const track of mixer.tracks.values()) {
              if (track.mediaEl === mediaEl) {
                mixer.tracks.delete(track.id)
                break
              }
            }

            return bridgeOutput
          }

          const source = new NativeMediaElementAudioSourceNode(audioContext, {
            mediaElement: mediaEl,
          })

          mixer.mediaWeakMap.set(mediaEl, source)
          return source
        },
      })

      /* MARK: Destination Node
      ------------------------- */

      Object.defineProperty(audioContext, "nativeDestination", {
        value: audioContext.destination,
      })

      const trackData = { realm: window, ...trackOptions }
      const destination = new GainNode(audioContext, {
        gain: inDesktopRealm ? 1 : 0,
      })

      destination.connect(audioContext.nativeDestination)

      if (mixer.addTrack) mixer.addTrack(destination, trackData)
      else mixer.outputs.push([destination, trackData])

      Object.defineProperty(audioContext, "destination", { value: destination })

      const nativeClose = audioContext.close.bind(audioContext)

      if (trackOptions.singleAudioContext) {
        audioContext.nativeClose = nativeClose
        audioContext.close = noopResolve
      }

      if (trackOptions.realm && trackOptions.realm !== window) {
        trackOptions.realm.addEventListener("pagehide", () => {
          const { id } = trackOptions
          const mixer = getMixer()
          if (mixer.willDestroy.has(id)) return
          if (mixer.tracks.has(id)) mixer.tracks.get(id).destroy()
          else if (audioContext.state !== "closed") {
            nativeClose()
            audioContext.close = noopResolve
            audioContext.suspend = noopResolve
            audioContext.resume = noopResolve
          }
        })
      }

      return audioContext
    }

    function patchAddModule(audioContext) {
      if (!inDesktopRealm) {
        // Set audioWorklet.addModule URL resolution relative to iframe URL
        if (audioContext.audioWorklet) {
          const nativeAddModule = audioContext.audioWorklet.addModule.bind(
            audioContext.audioWorklet,
          )
          audioContext.audioWorklet.addModule = (url) =>
            nativeAddModule(new URL(url, location.href).href)
        }
      }
    }

    window.AudioContext = new Proxy(window.AudioContext, {
      construct(Target, args) {
        if (mediaAudioContext && args.length === 0) {
          patchAddModule(mediaAudioContext)
          return mediaAudioContext
        }

        if (options.singleAudioContext && mainAudioContext) {
          return mainAudioContext
        }

        const mixer = getMixer()

        let context

        if (inOpaqueOrigin) {
          console.warn("Impossible to connect audio to mixer in opaqueOrigin")
          context = new Target(...args)
        } else if (inDesktopRealm) {
          context = mixer.createAudioContext({ args })
        } else {
          context = mixer.createAudioContext({
            args,
            // @ts-ignore
            id: window.frameElement.closest("ui-dialog")?.app.id,
            realm: window,
            autoResume: options.autoResume,
            singleAudioContext: options.singleAudioContext,
          })
        }

        mainAudioContext ??= context

        patchAddModule(context)

        return context
      },
    })

    const userGestures = [
      "click",
      "contextmenu",
      "auxclick",
      "dblclick",
      "mousedown",
      "mouseup",
      "pointerup",
      "touchend",
      "keydown",
      "keyup",
    ]

    const addPlayToStart = (autoResume = options.autoResume) => {
      if (autoResume === false) return
      if (desktopRealm.document.querySelector("#auto-resume-notice")) return

      const mixer = getMixer()
      if (mixer.userActive) return

      mixer.playToStartEl = document.createElement("dialog")
      mixer.playToStartEl.id = "auto-resume-notice"
      mixer.playToStartEl.className = "clear"

      const buttonEl = document.createElement("button")
      buttonEl.append(autoResume)
      mixer.playToStartEl.append(buttonEl)
      desktopRealm.document.body.append(mixer.playToStartEl)

      mixer.playToStartEl.showModal()
    }

    const resumeAllContexts = () => {
      const mixer = getMixer()
      let count = 0

      for (const context of mixer.contexts) {
        if (context.state === "running" || context.state === "closed") count++
        else context.resume()
      }

      if (count === mixer.contexts.length) {
        mixer.userActive = true

        for (const eventName of userGestures) {
          desktopRealm.removeEventListener(eventName, resumeAllContexts)
          window.removeEventListener(eventName, resumeAllContexts)
        }

        mixer.playToStartEl?.close()
        mixer.playToStartEl?.remove()
        mixer.playToStartEl = undefined

        mixer.contexts.length = 0
      }
    }

    for (const eventName of userGestures) {
      desktopRealm.addEventListener(eventName, resumeAllContexts)
      window.addEventListener(eventName, resumeAllContexts)
    }

    /* MARK: media elements
    ======================= */
    if (options.mediaElementInMixer !== false) {
      const appendMediaElement = (mediaEl) => {
        if (mediaEl.dataset.mixer === "false") return

        const mixer = getMixer()
        if (mixer.mediaWeakMap.has(mediaEl)) return

        let audioContext

        if (mediaAudioContext) {
          audioContext = mediaAudioContext
        } else if (mainAudioContext) {
          audioContext = mainAudioContext
        } else {
          audioContext = mixer.createAudioContext({
            mediaEl,
            id: mediaEl.closest("ui-dialog")?.app?.id,
            realm: window,
            autoResume: options.autoResume,
          })

          mediaAudioContext = audioContext
        }

        const source = audioContext.createMediaElementSource(mediaEl)
        mixer.mediaWeakMap.set(mediaEl, source)
        source.connect(audioContext.destination)
      }

      // @ts-ignore
      window.Audio = new Proxy(window.Audio, {
        construct(Target, args) {
          const mediaEl = new Target(...args)
          appendMediaElement(mediaEl)
          return mediaEl
        },
      })

      if (options.watchMediaElement) {
        new MutationObserver((mutationList) => {
          for (const mutation of mutationList) {
            for (const child of mutation.addedNodes) {
              if (child instanceof HTMLElement === false) continue

              if (child.localName === "audio" || child.localName === "video") {
                appendMediaElement(child)
              }

              for (const item of child.querySelectorAll("audio, video")) {
                appendMediaElement(item)
              }
            }
          }
        }).observe(document.documentElement, { childList: true, subtree: true })
      }

      for (const item of document.querySelectorAll("audio, video")) {
        appendMediaElement(item)
      }
    }
  }

  if (currentScript) core()
  else {
    const existingCore = document.head.querySelector("script[src$='core.js']")
    if (!existingCore) {
      console.warn(
        `No core.js found in ${document.URL}\nConsider adding <script src="/42/core.js"></script> to allow audio mixer to capture audio.`,
      )
      core()
    }
  }
})()
