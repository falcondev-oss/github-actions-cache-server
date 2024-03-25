import { build, createDevServer, createNitro, prepare } from 'nitropack'
import waitOn from 'wait-on'

import type { Nitro } from 'nitropack'

process.env.BASE_URL = 'http://localhost:3000'
process.env.DATA_DIR = '.data'
process.env.CACHE_SERVER_TOKEN = 'test_token'

let nitro: Nitro
export async function setup() {
  nitro = await createNitro({
    dev: true,
    preset: 'nitro-dev',
  })
  const server = createDevServer(nitro)
  await server.listen(3000, {
    hostname: '0.0.0.0',
    autoClose: true,
  })
  await prepare(nitro)
  await build(nitro)
  await waitOn({
    resources: ['http://localhost:3000'],
  })
}

export async function teardown() {
  await nitro?.close()
}
