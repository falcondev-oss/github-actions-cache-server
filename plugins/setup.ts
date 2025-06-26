import cluster from 'node:cluster'

import { H3Error } from 'h3'
import { useDB } from '~/lib/db'
import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'
import { useStorageAdapter } from '~/lib/storage'

export default defineNitroPlugin(async (nitro) => {
  const version = useRuntimeConfig().version
  if (cluster.isPrimary) logger.info(`🚀 Starting GitHub Actions Cache Server (${version})`)

  await useDB()
  await useStorageAdapter()

  nitro.hooks.hook('error', (error, { event }) => {
    if (!event) {
      logger.error(error)
      return
    }

    logger.error(
      `Response: ${event.method} ${event.path} > ${error instanceof H3Error ? error.statusCode : '[no status code]'}\n`,
      error,
    )
  })

  if (ENV.DEBUG) {
    nitro.hooks.hook('request', (event) => {
      logger.debug(`Request: ${event.method} ${event.path}`)
    })
    nitro.hooks.hook('afterResponse', (event) => {
      logger.debug(`Response: ${event.method} ${event.path} > ${getResponseStatus(event)}`)
    })
  }

  if (!version) throw new Error('No version found in runtime config')

  if (cluster.isPrimary) {
    const db = await useDB()
    const existing = await db
      .selectFrom('meta')
      .where('key', '=', 'version')
      .select('value')
      .executeTakeFirst()

    if (!existing || existing.value !== version) {
      logger.info(
        `Version changed from ${existing?.value ?? '[no version, first install]'} to ${version}. Pruning cache...`,
      )
      const adapter = await useStorageAdapter()
      await adapter.pruneCaches()
    }

    if (existing) {
      await db.updateTable('meta').set('value', version).where('key', '=', 'version').execute()
    } else {
      await db.insertInto('meta').values({ key: 'version', value: version }).execute()
    }
  }

  if (process.send && cluster.isPrimary) process.send('nitro:ready')
})
