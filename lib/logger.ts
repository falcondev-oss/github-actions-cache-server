import { LogLevels, createConsola } from 'consola'

export const logger = createConsola({
  defaults: {
    tag: 'cache-server',
  },
  level: process.env.NODE_ENV === 'development' ? LogLevels.debug : LogLevels.info,
})
