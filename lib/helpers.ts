import { createHash } from 'node:crypto'
import { customAlphabet } from 'nanoid'

const generate = customAlphabet('0123456789', 10)

export function generateNumberId() {
  return Number.parseInt(generate())
}

/** The key, version, scope and repo that at most one Upload may hold at a time. */
export interface Reservation {
  key: string
  version: string
  scope: string
  repoId: string
}

export function reservationHash({ key, version, scope, repoId }: Reservation) {
  return createHash('sha256')
    .update(JSON.stringify([key, version, scope, repoId]))
    .digest('hex')
}
