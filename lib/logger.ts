import { createConsola, LogLevels } from 'consola'

import { ENV } from '~/lib/env'

export const logger = createConsola({
  defaults: {
    tag: 'cache-server',
  },
  level: ENV.DEBUG ? LogLevels.debug : LogLevels.info,
})
