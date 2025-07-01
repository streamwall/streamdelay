import { fastifyWebsocket as websocketPlugin } from '@fastify/websocket'
import { type Static, Type } from '@sinclair/typebox'
import { timingSafeEqual } from 'crypto'
import {
  fastify,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import type { WebSocket } from 'ws'
import type { SnapshotFrom } from 'xstate'
import type { PipelineActor } from './pipelineMachine.ts'
import type { AppSettings } from './types.ts'

const StatusResponseSchema = Type.Object({
  delaySeconds: Type.Number(),
  restartSeconds: Type.Number(),
  isCensored: Type.Boolean(),
  isStreamRunning: Type.Boolean(),
  startTime: Type.Union([Type.Number(), Type.Null()]),
  state: Type.Any(),
})

const PatchStateRequestSchema = Type.Object({
  isCensored: Type.Optional(Type.Boolean()),
  isStreamRunning: Type.Optional(Type.Boolean()),
})

const WebSocketMessageSchema = Type.Object({
  type: Type.Literal('status'),
  status: StatusResponseSchema,
})

const QuerySchema = Type.Object({
  key: Type.Optional(Type.String()),
})

type StatusResponse = Static<typeof StatusResponseSchema>
type PatchStateRequest = Static<typeof PatchStateRequestSchema>
type WebSocketMessage = Static<typeof WebSocketMessageSchema>

export async function initAPIServer(
  argv: AppSettings & { apiHostname: string; apiPort: number; apiKey: string },
  pipelineService: PipelineActor,
): Promise<FastifyInstance> {
  const sockets = new Set<WebSocket>()

  const app = fastify({ logger: false })
  app.register(websocketPlugin)

  function formatStatus(snapshot: SnapshotFrom<PipelineActor>): StatusResponse {
    return {
      delaySeconds: argv.delaySeconds,
      restartSeconds: argv.restartSeconds,
      isCensored: snapshot.matches({ censorship: 'censored' }),
      isStreamRunning: snapshot.matches({ stream: 'running' }),
      startTime: snapshot.context.startTime,
      state: snapshot.value,
    }
  }

  function handlePatchState(patchState: PatchStateRequest): void {
    if (patchState.isCensored !== undefined) {
      pipelineService.send(
        patchState.isCensored ? { type: 'CENSOR' } : { type: 'UNCENSOR' },
      )
    }
    if (patchState.isStreamRunning !== undefined) {
      pipelineService.send(
        patchState.isStreamRunning ? { type: 'START' } : { type: 'STOP' },
      )
    }
  }

  app.addHook(
    'preHandler',
    async (
      request: FastifyRequest<{ Querystring: Static<typeof QuerySchema> }>,
      reply: FastifyReply,
    ) => {
      const providedApiKey =
        request.headers['streamdelay-api-key'] || request.query.key
      if (!providedApiKey) {
        reply.status(400).send({
          ok: false,
          error: 'missing api key',
        })
        return
      }
      if (
        providedApiKey.length != argv.apiKey.length ||
        !timingSafeEqual(
          Buffer.from(providedApiKey as string),
          Buffer.from(argv.apiKey),
        )
      ) {
        reply.status(403).send({
          ok: false,
          error: 'invalid api key',
        })
        return
      }
    },
  )

  app.register(async function (fastify) {
    fastify.get(
      '/ws',
      {
        websocket: true,
        schema: {
          querystring: QuerySchema,
        },
      },
      (ws, req) => {
        sockets.add(ws)

        ws.on('close', () => {
          sockets.delete(ws)
        })

        ws.on('message', (message: Buffer) => {
          const text = message.toString()
          let patchState: PatchStateRequest
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
            status: formatStatus(pipelineService.getSnapshot()),
          } as WebSocketMessage),
        )
      },
    )
  })

  let lastSnapshot: SnapshotFrom<PipelineActor> | undefined
  pipelineService.subscribe((snapshot) => {
    if (snapshot === lastSnapshot) {
      return
    }
    lastSnapshot = snapshot
    for (const ws of sockets) {
      ws.send(
        JSON.stringify({
          type: 'status',
          status: formatStatus(snapshot),
        } as WebSocketMessage),
      )
    }
  })

  app.get(
    '/status',
    {
      schema: {
        querystring: QuerySchema,
        response: {
          200: StatusResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return formatStatus(pipelineService.getSnapshot())
    },
  )

  app.patch<{ Body: PatchStateRequest }>(
    '/status',
    {
      schema: {
        querystring: QuerySchema,
        body: PatchStateRequestSchema,
        response: {
          200: StatusResponseSchema,
        },
      },
    },
    async (request, reply) => {
      handlePatchState(request.body)
      return formatStatus(pipelineService.getSnapshot())
    },
  )

  const address = await app.listen({
    port: argv.apiPort,
    host: argv.apiHostname,
  })

  console.log(`Server listening at ${address}`)

  return app
}
