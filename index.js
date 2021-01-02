const { timingSafeEqual } = require('crypto')
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')
const yargs = require('yargs')
const TOML = require('@iarna/toml')
const Koa = require('koa')
const bodyParser = require('koa-bodyparser')
const route = require('koa-route')
const websocket = require('koa-easy-ws')
const { Machine, interpret, send } = require('xstate')
const gstreamer = require('gstreamer-superficial')

const SEC = 1e9

function gstEscape(str) {
  // GStreamer interpets backslashes as escapes, so we need to escape them when passing them into pipeline syntax (such as for windows paths).
  return str.replace(/\\/g, '\\\\')
}

const pipelineMachine = Machine(
  {
    id: 'pipeline',
    type: 'parallel',
    context: {
      censor: false,
      settings: null,
    },
    states: {
      censorship: {
        initial: 'normal',
        on: {
          UNCENSOR: '.normal',
          CENSOR: '.censored',
        },
        states: {
          normal: {},
          censored: {
            initial: 'active',
            on: {
              UNCENSOR: '.deactivating',
            },
            states: {
              active: {},
              deactivating: {
                after: { STREAM_DELAY: '#pipeline.censorship.normal' },
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
          FINISHED: '.restarting',
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
              id: 'Pipeline',
              src: 'runPipeline',
            },
            on: { STARTED: '.started', START: {} },
            states: {
              waiting: {},
              started: {
                initial: 'normal',
                states: {
                  normal: {
                    entry: send('NORMAL', { to: 'Pipeline' }),
                    on: {
                      '': {
                        target: 'censored',
                        in: '#pipeline.censorship.censored',
                      },
                    },
                  },
                  censored: {
                    entry: send('CENSOR', { to: 'Pipeline' }),
                    on: {
                      '': {
                        target: 'normal',
                        in: '#pipeline.censorship.normal',
                      },
                    },
                  },
                },
              },
            },
          },
          error: {
            entry: 'logError',
          },
        },
      },
    },
  },
  {
    guards: {
      isCensoring: (context, event) => context.censor,
      isNotCensoring: (context, event) => !context.censor,
    },
    delays: {
      STREAM_DELAY: (context, event) =>
        context.settings ? 1000 * context.settings.delaySeconds : 0,
      RESTART_DELAY: (context, event) =>
        context.settings ? 1000 * context.settings.restartSeconds : 5000,
    },
    actions: {
      logError: (context, event) => {
        console.warn(event)
      },
    },
    services: {
      runPipeline: (context, event) => (callback, onReceive) => {
        const {
          width,
          height,
          srtInUri,
          inPipeline,
          outUri,
          outPipeline,
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
        } = context.settings

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
            demux.video ! queue ! video/x-h264 ! h264parse ! video/x-h264 ! avdec_h264 ! identity name="videoinput"
            demux.audio ! parsebin ! decodebin ! identity name="audioinput"
          `
        }

        if (!outPipeline) {
          if (outUri.startsWith('rtmp://')) {
            outPipeline = `flvmux name=mux streamable=true ! queue ! rtmpsink name=sink enable-last-sample=false location="${outUri} live=1"`
          } else if (outUri.startsWith('srt://')) {
            outPipeline = `mpegtsmux name=mux ! queue ! srtsink name=sink uri=${outUri}`
          } else {
            throw new Error(`Unexpected output stream protocol: ${outUri}`)
          }
        }

        let audioEncodePipeline
        let videoEncodePipeline
        if (encoder === 'none') {
          audioEncodePipeline = ''
          videoEncodePipeline = ''
        } else {
          let encoderPlugin
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
            min-threshold-time=${delayNs}
            max-size-time=${delayNs + 0.5 * SEC}
            max-size-buffers=0
            max-size-bytes=0

          # Auxiliary delay queue (for delaying audio in a split scenario)
          queue name=auxdelayqueue
            min-threshold-time=${delayNs}
            max-size-time=${delayNs + 0.5 * SEC}
            max-size-buffers=0
            max-size-bytes=0

          ${inPipeline}

          # Video pipeline: dynamically switch between a passthrough (uncensored) and pixelized/overlay (censored)
          videoinput. ! output-selector name=osel
          osel. ! queue ! isel.
          osel. ! queue
            ! videoscale
            ! video/x-raw,width=${pixelizedWidth},height=${pixelizedHeight}
            ! videoscale method=nearest-neighbour ! video/x-raw,width=${width},height=${height}
            ! gdkpixbufoverlay location=${gstEscape(overlayImg)}
            ! queue
            ! isel.
          input-selector name=isel ! ${dropQueue} name=videoqueue ${videoEncodePipeline}

          # Audio pipeline: dynamically adjusted volume (to mute when censoring)
          audioinput. ! audioconvert ! volume name=vol volume=0 ! audioconvert ! ${dropQueue} name=audioqueue ${audioEncodePipeline}
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

        const pipeline = new gstreamer.Pipeline(pipelineString)

        pipeline.pollBus((msg) => {
          if (msg.type === 'error') {
            console.error(msg)
          } else if (debug) {
            console.log(msg)
          }
          if (msg.type === 'eos' || msg.type === 'error') {
            callback('FINISHED')
          } else if (msg.type === 'stream-start') {
            callback('STARTED')
          }
        })

        let scriptProcess
        if (outScript) {
          scriptProcess = spawn(outScript, [], {
            shell: true,
            stdio: ['ignore', 'inherit', 'inherit'],
          })
          scriptProcess.once('exit', (code) => {
            if (code !== 0) {
              callback('FINISHED')
            }
          })
        }

        pipeline.play()

        onReceive((ev) => {
          if (ev.type === 'NORMAL') {
            pipeline.setPad('osel', 'active-pad', 'src_0')
            pipeline.setPad('isel', 'active-pad', 'sink_0')
            pipeline.findChild('vol').volume = 1
          } else if (ev.type === 'CENSOR') {
            pipeline.setPad('osel', 'active-pad', 'src_1')
            pipeline.setPad('isel', 'active-pad', 'sink_1')
            pipeline.findChild('vol').volume = 0
          } else {
            console.warn('unexpected event:', ev)
          }
        })

        let debugInterval
        if (debug) {
          function printQueue(name) {
            const q = pipeline.findChild(name)
            if (!q) {
              return
            }
            console.log(
              name,
              `time: ${q['current-level-time']} | bytes: ${q['current-level-bytes']} | max-time: ${q['max-size-time']}`,
            )
          }
          debugInterval = setInterval(() => {
            printQueue('delayqueue')
            printQueue('videoqueue')
            printQueue('audioqueue')
            printQueue('videobufqueue')
            printQueue('audiobufqueue')
            console.log('---')
          }, 1000)
        }

        return () => {
          clearInterval(debugInterval)
          pipeline.stop()
          if (scriptProcess) {
            scriptProcess.kill()
          }
        }
      },
    },
  },
)

function parseArgs() {
  const parser = yargs
    .config('config', (configPath) => {
      const content = fs.readFileSync(configPath, 'utf-8')
      if (configPath.endsWith('.toml')) {
        return TOML.parse(content)
      } else {
        return JSON.parse(content)
      }
    })
    .option('api-hostname', {
      describe: 'Override hostname the API server listens on',
      default: 'localhost',
    })
    .option('api-port', {
      describe: 'Override port the API server listens on',
      number: true,
      default: '8404',
    })
    .option('api-key', {
      describe: 'Secret key for accessing API',
      required: true,
    })
    .option('srt-in-uri', {
      describe: 'URI of input SRT stream',
    })
    .option('in-pipeline', {
      describe: 'Custom GStreamer pipeline for input',
      conflicts: ['srt-in-uri'],
    })
    .option('out-uri', {
      describe: 'URI of output SRT stream (srt:// or rtmp://)',
      conflicts: ['out-pipeline'],
    })
    .option('out-pipeline', {
      describe: 'Custom GStreamer pipeline for output',
      conflicts: ['out-uri'],
    })
    .option('out-script', {
      describe: 'Script to run when pipeline is running',
    })
    .option('delay-seconds', {
      describe: 'Number of seconds to delay stream',
      default: 15,
    })
    .option('restart-seconds', {
      describe:
        'Number of seconds to wait before restarting pipeline (on error)',
      default: 3,
    })
    .option('width', {
      describe: 'Width of stream',
      default: 1920,
    })
    .option('height', {
      describe: 'Height of stream',
      default: 1080,
    })
    .option('bitrate', {
      describe: 'Bitrate of stream',
      default: 4500,
    })
    .option('encoder', {
      describe: 'Encoder to use for h264',
      default: 'x264',
      choices: ['x264', 'nvenc', 'none'],
    })
    .option('x264-preset', {
      describe: 'Speed preset of x264 encoder',
      default: 'slow',
    })
    .option('x264-psy-tune', {
      describe: 'Psychovisual tuning setting of x264 encoder',
      default: 'none',
    })
    .option('x264-threads', {
      describe: 'Number of threads for x264 encoder',
      default: 0,
    })
    .option('nvenc-preset', {
      describe: 'Preset of nvenc encoder',
      default: 'low-latency-hq',
    })
    .option('pixelize-scale', {
      describe: 'Scale factor of pixelization (higher -> larger pixels)',
      default: 20,
    })
    .option('overlay-img', {
      describe: 'Path to overlay image (should have same dimensions as stream)',
      normalize: true,
      required: true,
    })
    .option('start', {
      describe: 'Start stream on initial run',
      boolean: true,
      default: true,
    })
    .option('debug', {
      describe: 'Print GStreamer debugging status information',
      boolean: true,
    })
  return parser.argv
}

function initPipeline(argv) {
  const machine = pipelineMachine.withContext({
    ...pipelineMachine.context,
    settings: argv,
  })

  const pipelineService = interpret(machine)

  pipelineService.onTransition((state) => {
    console.log('state:', state.value)
  })

  pipelineService.start()
  return pipelineService
}

function initAPIServer(argv, pipelineService) {
  const sockets = new Set()

  const app = new Koa()

  // silence koa printing errors when websockets close early
  app.silent = true

  app.use(bodyParser())
  app.use(websocket())

  function formatStatus(state) {
    return {
      delaySeconds: argv.delaySeconds,
      restartSeconds: argv.restartSeconds,
      isCensored: state.matches('censorship.censored'),
      isStreamRunning: state.matches('stream.running'),
      state: state.value,
    }
  }

  function handlePatchState(patchState) {
    if (patchState.isCensored !== undefined) {
      pipelineService.send(patchState.isCensored ? 'CENSOR' : 'UNCENSOR')
    }
    if (patchState.isStreamRunning !== undefined) {
      pipelineService.send(patchState.isStreamRunning ? 'START' : 'STOP')
    }
  }

  app.use(async (ctx, next) => {
    const { request } = ctx
    const providedApiKey =
      request.headers['streamdelay-api-key'] || request.query['key']
    if (!providedApiKey) {
      ctx.status = 400
      ctx.body = {
        ok: false,
        error: 'missing api key',
      }
      return
    }
    if (
      providedApiKey.length != argv.apiKey.length ||
      !timingSafeEqual(Buffer.from(providedApiKey), Buffer.from(argv.apiKey))
    ) {
      ctx.status = 403
      ctx.body = {
        ok: false,
        error: 'invalid api key',
      }
      return
    }
    await next()
  })

  app.use(
    route.get('/ws', async (ctx) => {
      if (!ctx.ws) {
        ctx.status = 404
        return
      }

      const ws = await ctx.ws()
      sockets.add(ws)

      ws.on('close', () => {
        sockets.delete(ws)
      })

      ws.on('message', (text) => {
        let patchState
        try {
          patchState = JSON.parse(text)
        } catch (err) {
          console.warn('received unexpected ws data:', text)
          return
        }

        try {
          handlePatchState(patchState)
        } catch (err) {
          console.error('failed to handle ws message:', text, err)
        }
      })

      ws.send(
        JSON.stringify({
          type: 'status',
          status: formatStatus(pipelineService.state),
        }),
      )
    }),
  )

  pipelineService.onTransition((state) => {
    if (!state.changed) {
      return
    }
    for (const ws of sockets) {
      ws.send(
        JSON.stringify({
          type: 'status',
          status: formatStatus(state),
        }),
      )
    }
  })

  app.use(
    route.get(`/status`, async (ctx) => {
      ctx.body = formatStatus(pipelineService.state)
    }),
  )

  app.use(
    route.patch(`/status`, async (ctx) => {
      const { request } = ctx
      handlePatchState(request.body)
      ctx.body = formatStatus(pipelineService.state)
    }),
  )

  const server = http.createServer(app.callback())
  server.listen(argv.apiPort, argv.apiHostname)

  return app
}

function main() {
  const argv = parseArgs()
  const pipelineService = initPipeline(argv)
  if (argv.start) {
    pipelineService.send({ type: 'START' })
  }
  initAPIServer(argv, pipelineService)
}

main()
