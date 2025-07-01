import { ChildProcess, spawn } from 'child_process'
import { Pipeline } from 'gst-kit'
import {
  Actor,
  assign,
  createActor,
  fromCallback,
  raise,
  sendTo,
  setup,
  stateIn,
} from 'xstate'
import type { AppSettings } from './types.ts'

const SEC = 1e9

interface PipelineContext {
  startTime: number | null
  settings: AppSettings
}

interface PipelineControlEvent {
  type: 'RENDER_NORMAL' | 'RENDER_CENSORED'
}

interface PipelineStatusEvent {
  type: 'PIPELINE_ENDED' | 'PIPELINE_STARTED'
}

function gstEscape(str: string): string {
  // GStreamer interpets backslashes as escapes, so we need to escape them when passing them into pipeline syntax (such as for windows paths).
  return str.replace(/\\/g, '\\\\')
}

const pipelineMachine = setup({
  types: {} as {
    events:
      | { type: 'START' }
      | { type: 'STOP' }
      | { type: 'CENSOR' }
      | { type: 'UNCENSOR' }
      | { type: 'NORMAL' }
      | PipelineStatusEvent
    input: { settings: AppSettings }
    context: PipelineContext
  },
  guards: {
    isCensored: stateIn('#pipeline.censorship.censored'),
    isNormal: stateIn('#pipeline.censorship.normal'),
  },
  delays: {
    STREAM_DELAY: ({ context }) =>
      context.settings ? 1000 * context.settings.delaySeconds : 0,
    RESTART_DELAY: ({ context }) =>
      context.settings ? 1000 * context.settings.restartSeconds : 5000,
  },
  actions: {
    logError: ({ event }) => {
      console.warn(event)
    },
  },
  actors: {
    runPipeline: fromCallback<PipelineControlEvent, { settings: AppSettings }>(
      ({ input: { settings }, sendBack, receive }) => {
        const {
          width,
          height,
          srtInUri,
          outUri,
          outScript,
          delaySeconds,
          bitrate,
          encoder,
          x264Preset,
          x264PsyTune,
          x264Threads,
          nvencPreset,
          pixelizeScale,
          overlayImg,
          debug,
        } = settings
        let { inPipeline, outPipeline } = settings

        const pixelizedWidth = Math.floor(width / pixelizeScale)
        const pixelizedHeight = Math.floor(height / pixelizeScale)
        const delayNs = delaySeconds * SEC

        const bufferQueue = `
          queue
            max-size-time=${delayNs}
            max-size-buffers=0
            max-size-bytes=0
        `

        const dropQueue = `
          queue
            leaky=downstream
            max-size-time=${1 * SEC}
            max-size-buffers=0
            max-size-bytes=0
        `

        if (!inPipeline) {
          inPipeline = `
            srtsrc name=src uri=${srtInUri} do-timestamp=true ! tsparse set-timestamps=true smoothing-latency=1000 ! maindelayqueue. maindelayqueue. ! tsdemux name=demux
            demux. ! queue ! video/x-h264 ! h264parse ! video/x-h264 ! avdec_h264 ! identity name="videoinput"
            demux. ! queue ! parsebin ! decodebin ! audio/x-raw ! identity name="audioinput"
          `
        }

        if (!outPipeline) {
          if (!outUri) {
            throw new Error('Missing outUri')
          }
          if (outUri.startsWith('rtmp://')) {
            outPipeline = `flvmux name=mux streamable=true ! queue ! rtmpsink name=sink enable-last-sample=false location="${outUri} live=1"`
          } else if (outUri.startsWith('srt://')) {
            outPipeline = `mpegtsmux name=mux ! queue ! srtsink name=sink uri=${outUri}`
          } else {
            throw new Error(`Unexpected output stream protocol: ${outUri}`)
          }
        }

        let audioEncodePipeline: string
        let videoEncodePipeline: string
        if (encoder === 'none') {
          audioEncodePipeline = ''
          videoEncodePipeline = ''
        } else {
          let encoderPlugin: string
          if (encoder === 'x264') {
            encoderPlugin = `x264enc bitrate=${bitrate} tune=zerolatency speed-preset=${x264Preset} byte-stream=true threads=${x264Threads} psy-tune=${x264PsyTune} key-int-max=60`
          } else if (encoder === 'nvenc') {
            encoderPlugin = `nvh264enc bitrate=${bitrate} preset=${nvencPreset} rc-mode=cbr gop-size=60 ! queue ! h264parse config-interval=2`
          } else {
            throw new Error(`Unexpected encoder: ${encoder}`)
          }
          audioEncodePipeline = `! voaacenc bitrate=96000 ! aacparse ! ${bufferQueue} name=audiobufqueue ! mux.`
          videoEncodePipeline = `! ${encoderPlugin} ! ${bufferQueue} name=videobufqueue ! mux.`
        }

        const pipelineSource = `
          # Main delay queue (for delaying encoded input in default config, or video in a split scenario)
          queue name=maindelayqueue
            max-size-time=${delayNs + 0.5 * SEC}
            max-size-buffers=0
            max-size-bytes=0

          # Auxiliary delay queue (for delaying audio in a split scenario)
          queue name=auxdelayqueue
            max-size-time=${delayNs + 0.5 * SEC}
            max-size-buffers=0
            max-size-bytes=0

          ${inPipeline}

          # Video pipeline: dynamically switch between a passthrough (uncensored) and pixelized/overlay (censored)
          videoinput. ! output-selector name=vsel
          vsel. ! vfun.
          vsel.
            ! videoscale
            ! video/x-raw,width=${pixelizedWidth},height=${pixelizedHeight}
            ! videoscale method=nearest-neighbour ! video/x-raw,width=${width},height=${height}
            ! gdkpixbufoverlay location=${gstEscape(overlayImg)}
            ! vfun.
          funnel name=vfun ! ${dropQueue} name=videoqueue ${videoEncodePipeline}

          # Audio pipeline: dynamically adjusted volume (to mute when censoring)
          audioinput. ! audioconvert ! volume name=vol volume=0 ! ${dropQueue} name=audioqueue ${audioEncodePipeline}
          ${outPipeline}
        `

        if (debug) {
          console.log('pipeline:', pipelineSource)
        }

        // Remove comments
        const pipelineString = pipelineSource
          .split('\n')
          .filter((line) => !line.match(/^\s*#/))
          .join('\n')

        const pipeline = new Pipeline(pipelineString)

        const busController = new AbortController()
        async function watchBus() {
          while (!busController.signal.aborted) {
            const msg = await pipeline.busPop(1000)
            if (!msg) {
              continue
            }

            if (msg.type === 'error') {
              console.error(msg)
            } else if (
              debug &&
              msg.type !== 'state-changed' &&
              msg.name !== 'GstMessageStreamStatus'
            ) {
              console.log(msg)
            }
            if (msg.type === 'eos' || msg.type === 'error') {
              sendBack({ type: 'PIPELINE_ENDED' })
            } else if (msg.type === 'stream-start') {
              pipeline
                .getElementByName('maindelayqueue')
                ?.setElementProperty('min-threshold-time', delayNs)
              pipeline
                .getElementByName('auxdelayqueue')
                ?.setElementProperty('min-threshold-time', delayNs)
              sendBack({ type: 'PIPELINE_STARTED' })
            }
          }
        }
        watchBus()

        let scriptProcess: ChildProcess | undefined
        if (outScript) {
          scriptProcess = spawn(outScript, [], {
            shell: true,
            stdio: ['ignore', 'inherit', 'inherit'],
          })
          scriptProcess.once('exit', (code) => {
            if (code !== 0) {
              sendBack({ type: 'PIPELINE_ENDED' })
            }
          })
        }

        pipeline.play()

        const videoSelector = pipeline.getElementByName('vsel')
        const vol = pipeline.getElementByName('vol')

        receive((ev) => {
          if (ev.type === 'RENDER_NORMAL') {
            videoSelector?.setPad('active-pad', 'src_0')
            vol?.setElementProperty('volume', 1)
          } else if (ev.type === 'RENDER_CENSORED') {
            videoSelector?.setPad('active-pad', 'src_1')
            vol?.setElementProperty('volume', 0)
          } else {
            console.warn('unexpected event:', ev)
          }
        })

        let debugInterval: NodeJS.Timeout | undefined
        if (debug) {
          function printQueue(name: string) {
            const q = pipeline.getElementByName(name)
            if (!q) {
              return
            }
            console.log(
              name,
              `time: ${q.getElementProperty('current-level-time')?.value} | bytes: ${q.getElementProperty('current-level-bytes')?.value} | max-time: ${q.getElementProperty('max-size-time')?.value}`,
            )
          }

          function printMediaStats() {
            console.log(
              pipeline.getElementByName('videoinput')?.getPad('src')?.caps,
            )
            console.log(
              pipeline.getElementByName('audioinput')?.getPad('src')?.caps,
            )
          }

          debugInterval = setInterval(() => {
            printMediaStats()
            printQueue('maindelayqueue')
            printQueue('auxdelayqueue')
            printQueue('videoqueue')
            printQueue('audioqueue')
            printQueue('videobufqueue')
            printQueue('audiobufqueue')
            console.log('---')
          }, 1000)
        }

        return () => {
          if (debugInterval) {
            clearInterval(debugInterval)
          }
          pipeline.stop()
          busController.abort()
          if (scriptProcess) {
            scriptProcess.kill()
          }
        }
      },
    ),
  },
}).createMachine({
  id: 'pipeline',
  type: 'parallel',
  context: ({ input: { settings } }) => ({
    startTime: null,
    settings,
  }),
  states: {
    censorship: {
      initial: 'normal',
      states: {
        normal: {
          entry: raise({ type: 'NORMAL' }),
          on: {
            CENSOR: 'censored',
          },
        },
        censored: {
          initial: 'active',
          entry: raise({ type: 'CENSOR' }),
          on: {
            UNCENSOR: '.deactivating',
          },
          states: {
            active: {},
            deactivating: {
              after: {
                STREAM_DELAY: { target: '#pipeline.censorship.normal' },
              },
            },
          },
        },
      },
    },
    stream: {
      initial: 'stopped',
      on: {
        START: '.running',
        STOP: '.stopped',
        PIPELINE_ENDED: '.restarting',
      },
      states: {
        stopped: {},
        restarting: {
          after: {
            RESTART_DELAY: 'running',
          },
        },
        running: {
          initial: 'waiting',
          invoke: {
            id: 'pipelineActor',
            src: 'runPipeline',
            input: ({ context: { settings } }) => ({ settings }),
          },
          on: { PIPELINE_STARTED: '.started', START: {} },
          states: {
            waiting: {},
            started: {
              entry: assign({ startTime: () => Date.now() }),
              exit: assign({ startTime: null }),
              always: [
                {
                  guard: 'isCensored',
                  actions: sendTo('pipelineActor', { type: 'RENDER_CENSORED' }),
                },
                {
                  guard: 'isNormal',
                  actions: sendTo('pipelineActor', { type: 'RENDER_NORMAL' }),
                },
              ],
            },
          },
        },
        error: {
          entry: 'logError',
        },
      },
    },
  },
})

export type PipelineActor = Actor<typeof pipelineMachine>

export function initPipeline(argv: AppSettings) {
  const actor = createActor(pipelineMachine, {
    input: {
      settings: argv,
    },
  })

  actor.subscribe((state) => {
    console.log('state:', state.value)
  })

  actor.start()
  return actor
}
