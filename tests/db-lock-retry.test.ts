import { describe, expect, test, vi } from 'vitest'
import { retryOnLockConflict } from '~/lib/db'

function lockError(code: string) {
  return Object.assign(new Error('Deadlock found when trying to get lock'), { code })
}

describe('retryOnLockConflict', () => {
  test('retries a deadlock victim until it succeeds', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(lockError('ER_LOCK_DEADLOCK'))
      .mockResolvedValueOnce('merged')

    await expect(retryOnLockConflict(run)).resolves.toBe('merged')
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('gives up after the attempt limit', async () => {
    const run = vi.fn().mockRejectedValue(lockError('40P01'))

    await expect(retryOnLockConflict(run, 2)).rejects.toThrow('Deadlock')
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('rethrows anything that is not a lock conflict', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Merge lease was lost before completion'))

    await expect(retryOnLockConflict(run)).rejects.toThrow('Merge lease was lost')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
