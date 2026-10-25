import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test } from 'vitest'
import { getDatabase } from '~/lib/db'

// A client checked out at startup and never released keeps the pool one short
// and makes `pool.end()` wait forever.
test('destroying the database does not hang on a client held since startup', async () => {
  const db = await getDatabase()
  expect(await Promise.race([db.destroy().then(() => 'destroyed'), sleep(5000, 'hung')])).toBe(
    'destroyed',
  )
})
