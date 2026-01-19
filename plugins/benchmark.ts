import cluster from 'node:cluster'
import fs from 'node:fs/promises'
import { env } from '~/lib/env'
import { logger } from '~/lib/logger'

export default defineNitroPlugin(async () => {
  if (!env.BENCHMARK || cluster.isPrimary) return

  const logFile = 'benchmark.csv'
  await fs.writeFile(logFile, 'time,rss_mb,heap_total_mb,heap_used_mb,external_mb\n')

  logger.info('Starting benchmark logging to', logFile)

  setInterval(async () => {
    const mem = process.memoryUsage()
    await fs.appendFile(
      logFile,
      `${Date.now()},${toMB(mem.rss)},${toMB(mem.heapTotal)},${toMB(mem.heapUsed)},${toMB(mem.external)}\n`,
    )
  }, 250)
})

function toMB(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(2)
}
