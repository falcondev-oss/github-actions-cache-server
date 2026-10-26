import { test } from 'vitest'
import { getDatabase } from '~/lib/db'

// A client checked out at startup and never released keeps the pool one short
// and makes `pool.end()` wait forever.
test(
  'destroying the database does not hang on a client held since startup',
  { timeout: 5000 },
  async () => {
    const db = await getDatabase()
    await db.destroy()
  },
)
