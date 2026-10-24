import type { ConsolaReporter } from 'consola'
import type { NitroApp, NitroRuntimeHooks } from 'nitropack'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import { inspect } from 'node:util'

import { LogLevels } from 'consola'
import * as h3 from 'h3'
import { createHooks } from 'hookable'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { env } from '~/lib/env'
import { logger } from '~/lib/logger'
import { getStorage } from '~/lib/storage'

// The real upload route and request-logging plugin on an in-process h3 app,
// wired to the plugin's hooks the way Nitro's app is, so the server log is observable.
const hooks = createHooks<NitroRuntimeHooks>()
const router = h3.createRouter({ preemptive: true })
const server = http.createServer(
  h3.toNodeListener(
    h3
      .createApp({
        onError: (error, event) => hooks.callHook('error', error, { event, tags: ['request'] }),
        onRequest: (event) => hooks.callHook('request', event),
        onAfterResponse: (event, response) => hooks.callHook('afterResponse', event, response),
      })
      .use(router),
  ),
)

const logs: string[] = []
const reporter: ConsolaReporter = {
  log: (entry) => {
    logs.push(entry.args.map((arg) => inspect(arg)).join(' '))
  },
}
const originalLevel = logger.level
const originalDebug = env.DEBUG
const proxyRequest = vi.fn(() => null)

beforeAll(async () => {
  for (const [name, value] of Object.entries(h3)) vi.stubGlobal(name, value)
  vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
  // Every request-logging hook, including the debug ones, must keep the query out.
  env.DEBUG = true
  logger.level = LogLevels.debug
  logger.addReporter(reporter)

  // Not static imports: the plugin and route call Nitro auto-imports
  // (`defineNitroPlugin`, `defineEventHandler`, …) at evaluation time.
  const { default: requestLogging } = await import('~/plugins/request-logging')
  // `hookable` here is the app's copy, not Nitro's; the runtime API is the same.
  requestLogging({ hooks } as unknown as NitroApp)
  const { default: upload } = await import('~/routes/devstoreaccount1/upload/[uploadId].put')
  const { default: passthrough } = await import('~/routes/[...path]')
  // The upstream Results service is not under test; only what is logged and forwarded is.
  vi.stubGlobal('proxyRequest', proxyRequest)
  router.put('/upload/:uploadId', upload).use('/**', passthrough)
  server.listen(0)
  await once(server, 'listening')
})

afterAll(async () => {
  logger.removeReporter(reporter)
  logger.level = originalLevel
  env.DEBUG = originalDebug
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  server.close()
  await once(server, 'close')
})

test('query strings stay out of request, error and passthrough logs', async () => {
  const storage = await getStorage()
  const created = await storage.createUpload({
    key: `request-logging-${randomUUID()}`,
    version: 'v1',
    scope: 'refs/heads/main',
    repoId: '123',
  })

  const { port } = server.address() as AddressInfo
  // Azure Blob clients send SAS-style credentials in the query.
  const secret = randomBytes(32).toString('hex')
  const url = `http://localhost:${port}/upload/${created.id}?sig=${secret}`

  const stored = await fetch(url, { method: 'PUT', body: 'part' })
  expect(stored.status).toBe(201)

  // Storage failing mid-upload (e.g. the backend is unreachable) is logged as an error.
  vi.spyOn(storage.adapter, 'uploadStream').mockRejectedValue(new Error('storage unavailable'))
  const blockId = Buffer.from(`${randomUUID()}000000000001`).toString('base64')
  const failed = await fetch(`${url}&comp=block&blockid=${encodeURIComponent(blockId)}`, {
    method: 'PUT',
    body: 'part',
  })
  expect(failed.status).toBe(500)
  await vi.waitFor(() => expect(logs.join('\n')).toContain('> 500'))

  // An unknown path falls through to the Results Passthrough.
  const unknown = await fetch(`http://localhost:${port}/uploads/${created.id}?sig=${secret}`)
  expect(unknown.status).toBe(204)
  await vi.waitFor(() => expect(logs.join('\n')).toContain(`proxying unknown path`))
  expect(proxyRequest).toHaveBeenCalledTimes(1)

  const logged = logs.join('\n')
  expect(logged).toContain(`/upload/${created.id}`)
  expect(logged).toContain('storage unavailable')
  expect(logged).not.toContain('sig=')
  expect(logged).not.toContain(secret)
})
