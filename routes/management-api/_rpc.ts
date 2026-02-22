import { onError } from '@orpc/client'
import { RPCHandler } from '@orpc/server/fetch'
import { CORSPlugin } from '@orpc/server/plugins'
import { env } from '~/lib/env'
import { managementApiLogger, router } from './[...]'

const handler = new RPCHandler(router, {
  plugins: [new CORSPlugin()],
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
    prefix: '/management-api/_rpc',
  })

  if (response) return response

  throw createError({ statusCode: 404 })
})
