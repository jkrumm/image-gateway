import { Elysia } from 'elysia'
import { z } from 'zod'
import { openapi } from '@elysiajs/openapi'
import { PLAYBOOK_VERSION } from '@image-gateway/shared'
import { env } from './env.js'
import { authGuard } from './lib/auth-guard.js'
import { healthRoute, setDraining } from './routes/health.js'
import { generateRoutes } from './routes/generate.js'
import { editRoutes } from './routes/edit.js'
import { enhanceRoutes } from './routes/enhance.js'
import { cutoutRoutes } from './routes/cutout.js'
import { iconsRoutes } from './routes/icons.js'

export const app = new Elysia()
  .use(
    openapi({
      mapJsonSchema: { zod: z.toJSONSchema },
      documentation: {
        info: {
          title: 'image-gateway',
          version: '0.1.0',
          description:
            'Stateless gateway wrapping the gpt-image model family. Accepts a prompt and parameters, calls the upstream image-generations/edits endpoints, and returns base64 images with usage/cost telemetry. Supports SSE streaming previews on both `/generate` and `/edit`. Also exposes `/enhance`, the "Plan" brain: compiles the versioned playbook into a system prompt, asks a text model for a structured plan, and resolves it through `rules.ts` — never generates an image. `/cutout` removes an image background via Replicate; `/icons` turns one master image into a full web/PWA/macOS icon set. No database, no image storage. All routes except `GET /` and `GET /health` require `Authorization: Bearer <API_SECRET>`.',
        },
        components: {
          securitySchemes: {
            BearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        tags: [
          {
            name: 'Images',
            description: 'Generate and edit/inpaint images, with optional SSE streaming.',
          },
          {
            name: 'Prompts',
            description: 'Plan an image-generation prompt — never returns an image.',
          },
          {
            name: 'Assets',
            description:
              'Background removal and icon-set generation from an existing image — never generates a new one.',
          },
          { name: 'System', description: 'Discovery and health endpoints.' },
        ],
      },
    }),
  )
  .onError(({ error }) => {
    // oxlint-disable-next-line no-console -- top-level error sink, not request-scoped structured logging
    console.error('[error]', error)
  })
  .get(
    '/',
    () => ({
      name: 'image-gateway',
      version: '0.1.0',
      docs: {
        scalar: '/openapi',
        json: '/openapi/json',
      },
      auth: {
        scheme: 'Bearer',
        header: 'Authorization: Bearer <API_SECRET>',
        public: ['GET /', 'GET /health'],
      },
      endpoints: {
        generate: 'POST /generate',
        edit: 'POST /edit',
        enhance: 'POST /enhance',
        cutout: 'POST /cutout',
        icons: 'POST /icons',
      },
      playbook_version: PLAYBOOK_VERSION,
    }),
    {
      response: z.object({
        name: z.string(),
        version: z.string(),
        docs: z.object({
          scalar: z.string().describe('Interactive OpenAPI UI'),
          json: z.string().describe('Raw OpenAPI JSON spec'),
        }),
        auth: z.object({
          scheme: z.string(),
          header: z.string(),
          public: z.array(z.string()),
        }),
        endpoints: z.object({
          generate: z.string(),
          edit: z.string(),
          enhance: z.string(),
          cutout: z.string(),
          icons: z.string(),
        }),
        playbook_version: z.string().describe('Current shared/playbook/ doctrine version'),
      }),
      detail: {
        tags: ['System'],
        summary: 'API discovery — start here',
        description:
          'Public root endpoint. Returns the service name, version, where to find the OpenAPI spec, auth scheme, and the main endpoints.',
      },
    },
  )
  .use(healthRoute)
  .use(authGuard)
  .use(generateRoutes)
  .use(editRoutes)
  .use(enhanceRoutes)
  .use(cutoutRoutes)
  .use(iconsRoutes)
  .listen({ port: env.PORT, idleTimeout: 255 })

export type App = typeof app

// oxlint-disable-next-line no-console -- startup log, not request-scoped structured logging
console.log(`image-gateway running on port ${env.PORT}`)

// Graceful shutdown: stop accepting new work and let /health report 503
// immediately, then close the server.
const shutdown = (signal: string): void => {
  // oxlint-disable-next-line no-console -- shutdown log, not request-scoped structured logging
  console.log(`image-gateway received ${signal}, shutting down`)
  setDraining(true)
  void app.stop().then(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
