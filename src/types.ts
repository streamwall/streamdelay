export interface AppSettings {
  width: number
  height: number
  srtInUri?: string
  outUri?: string
  outScript?: string
  delaySeconds: number
  restartSeconds: number
  bitrate: number
  encoder: 'x264' | 'nvenc' | 'none'
  x264Preset: string
  x264PsyTune: string
  x264Threads: number
  nvencPreset: string
  pixelizeScale: number
  overlayImg: string
  debug?: boolean
  inPipeline?: string
  outPipeline?: string
}
