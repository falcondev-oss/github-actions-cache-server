import mockttp from 'mockttp'
import { ENV } from './env'
import { logger } from './logger'

export async function initializeProxy() {
  if (ENV.DISABLE_PROXY) {
    logger.warn('Proxy is disabled')
    return
  }

  const port = ENV.PROXY_PORT
  logger.info(`Starting proxy server on port ${port}...`)

  // generate ca with `openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -sha256 -days 365`
  const server = mockttp.getLocal({
    https: {
      keyPath: ENV.CA_KEY_PATH,
      certPath: ENV.CA_CERT_PATH,
      tlsInterceptOnly: [
        {
          hostname: 'results-receiver.actions.githubusercontent.com',
        },
      ],
    },
    http2: true,
    debug: ENV.DEBUG,
  })

  await server
    .forAnyRequest()
    .withUrlMatching(
      /(twirp\/github\.actions\.results\.api\.v1\.CacheService)|(_apis\/artifactcache)/,
    )
    .thenForwardTo(`http://localhost:${ENV.NITRO_PORT}`)

  await server.forAnyWebSocket().thenPassThrough()
  await server.forUnmatchedRequest().thenPassThrough()

  await server.start(port)
}
