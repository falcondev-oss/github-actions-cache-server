import type { H3Event } from 'h3'
import { ORPCError, os } from '@orpc/server'
import { getDatabase } from '../db'
import { env } from '../env'
import { getStorage } from '../storage'

export const base = os
  .$context<{
    event: H3Event
  }>()
  .use(async ({ next, context }) => {
    const apiKey = getHeader(context.event, 'x-api-key')
    if (apiKey !== env.MANAGEMENT_API_KEY) throw new ORPCError('UNAUTHORIZED')

    const storage = await getStorage()
    const db = await getDatabase()

    return next({
      context: {
        db,
        storage,
      },
    })
  })
