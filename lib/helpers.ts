import type { H3Event } from 'h3'
import { createHash } from 'node:crypto'
import { customAlphabet } from 'nanoid'

const generate = customAlphabet('0123456789', 10)

export function generateNumberId() {
  return Number.parseInt(generate())
}

/**
 * The request path without its query string, for logging. A query can carry
 * credentials (signed URLs, SAS-style parameters), so it must never reach the logs.
 */
export function loggedPath(event: H3Event) {
  return event.path.split('?', 1)[0]
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
