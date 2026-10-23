import { createHash } from 'node:crypto'
import { customAlphabet } from 'nanoid'

const generate = customAlphabet('0123456789', 10)

export function generateNumberId() {
  return Number.parseInt(generate())
}

/** Identifies the single Upload allowed per key, version, scope and repo. */
export function reservationHash({
  key,
  version,
  scope,
  repoId,
}: {
  key: string
  version: string
  scope: string
  repoId: string
}) {
  return createHash('sha256')
    .update(JSON.stringify([key, version, scope, repoId]))
    .digest('hex')
}
