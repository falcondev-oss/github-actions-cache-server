import { build, createDevServer, createNitro, prepare } from 'nitropack'

import type { Nitro, NitroDevServer } from 'nitropack'

process.env.BASE_URL = 'http://localhost:3000'
process.env.DATA_DIR = '.data'
process.env.CACHE_SERVER_TOKEN = 'test_token'

let nitro: Nitro
let server: Awaited<ReturnType<NitroDevServer['listen']>>
export async function setup() {
  nitro = await createNitro({
    dev: true,
    preset: 'nitro-dev',
  })
  server = await createDevServer(nitro).listen(3000, {
    hostname: '0.0.0.0',
    autoClose: true,
  })
  await prepare(nitro)
  const ready = new Promise<void>((resolve) => {
    nitro.hooks.hook('dev:reload', () => resolve())
  })
  await build(nitro)
  await ready
}

export async function teardown() {
  await server?.close()
  await nitro?.close()
}
