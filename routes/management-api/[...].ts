import { onError } from '@orpc/client'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { CORSPlugin } from '@orpc/server/plugins'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { cacheEntriesRouter } from '~/lib/api/cache-entries'
import { storageLocationsRouter } from '~/lib/api/storage-locations'
import { env } from '~/lib/env'
import { logger } from '~/lib/logger'

export const router = {
  cacheEntries: cacheEntriesRouter,
  storageLocations: storageLocationsRouter,
}

export const managementApiLogger = logger.withTag('management-api')

const handler = new OpenAPIHandler(router, {
  plugins: [
    new CORSPlugin(),
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: 'Cache Server Management API',
          version: '1.0.0',
        },
        servers: [{ url: `${env.API_BASE_URL}/management-api` }],
        security: [
          {
            apiKeyHeader: [],
          },
        ],
      },
      docsConfig: {
        authentication: {
          securitySchemes: {
            apiKeyHeader: {
              name: 'X-Api-Key',
              in: 'header',
              value: '',
            },
          },
        },
      },
      docsPath: '/_docs',
      specPath: '/_docs/spec.json',
    }),
  ],
  interceptors: [
    onError((error) => {
      managementApiLogger.error(error)
    }),
  ],
})

export default defineEventHandler(async (event) => {
  if (!env.MANAGEMENT_API_KEY)
    throw createError({ statusCode: 503, message: 'Management API is disabled' })

  const { response } = await handler.handle(toWebRequest(event), {
    context: { event },
    prefix: '/management-api',
  })
  if (response) return response

  throw createError({ statusCode: 404 })
})
