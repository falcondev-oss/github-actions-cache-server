import cluster from 'node:cluster'

import { createConsola, LogLevels } from 'consola'
import { env } from './env'

export const logger = createConsola({
  defaults: {
    tag: cluster.isPrimary ? 'cache-server' : `cache-server-node-${cluster.worker?.id}`,
  },
  level: env.DEBUG ? LogLevels.debug : LogLevels.info,
})
