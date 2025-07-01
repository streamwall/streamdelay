import * as TOML from '@iarna/toml'
import * as fs from 'fs'
import yargs from 'yargs'
import { initPipeline } from './pipelineMachine.ts'
import { initAPIServer } from './server.ts'
import type { AppSettings } from './types.ts'

type Arguments = AppSettings & {
  apiHostname: string
  apiPort: number
  apiKey: string
  start: boolean
}

function parseArgs() {
  return yargs()
    .config('config', (configPath: string) => {
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
    .check((argv) => {
      if (!argv['srt-in-uri'] && !argv['in-pipeline']) {
        throw new Error(
          'Either --srt-in-uri or --in-pipeline must be specified.',
        )
      }

      if (!argv['out-uri'] && !argv['out-pipeline']) {
        throw new Error('Either --out-uri or --out-pipeline must be specified.')
      }

      return true
    })

    .help()
    .parseSync(process.argv) as Arguments
}

async function main(): Promise<void> {
  const argv = parseArgs()

  console.log(
    `🔌 Streamdelay endpoint: http://${argv.apiHostname}:${argv.apiPort}`,
  )

  console.log(`🔑 Streamdelay key: ${argv.apiKey}`)

  const pipelineService = initPipeline(argv)
  if (argv.start) {
    pipelineService.send({ type: 'START' })
  }
  await initAPIServer(argv, pipelineService)
}

main()
