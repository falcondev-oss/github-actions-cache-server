import crypto from 'node:crypto'

import { SignJWT } from 'jose'
import protobuf from 'protobufjs'
import { beforeAll, expect, test } from 'vitest'

// Independent client-side schema (matches GitHub's CacheService proto). Requests
// include `metadata` — a field the server does not declare — to prove it is
// skipped during decode.
const root = protobuf.parse(
  `
  syntax = "proto3";
  message CacheMetadata { int64 repository_id = 1; }
  message CreateCacheEntryRequest { CacheMetadata metadata = 1; string key = 2; string version = 3; }
  message CreateCacheEntryResponse { bool ok = 1; string signed_upload_url = 2; string message = 3; }
  message FinalizeCacheEntryUploadRequest { CacheMetadata metadata = 1; string key = 2; int64 size_bytes = 3; string version = 4; }
  message GetCacheEntryDownloadURLRequest { CacheMetadata metadata = 1; string key = 2; repeated string restore_keys = 3; string version = 4; }
  message GetCacheEntryDownloadURLResponse { bool ok = 1; string signed_download_url = 2; string matched_key = 3; }
`,
  { keepCase: true },
).root

const CreateReq = root.lookupType('CreateCacheEntryRequest')
const CreateRes = root.lookupType('CreateCacheEntryResponse')
const FinalizeReq = root.lookupType('FinalizeCacheEntryUploadRequest')
const GetReq = root.lookupType('GetCacheEntryDownloadURLRequest')
const GetRes = root.lookupType('GetCacheEntryDownloadURLResponse')

let token: string

beforeAll(async () => {
  token = await new SignJWT({
    ac: JSON.stringify([{ Scope: 'refs/heads/main', Permission: 3 }]),
    repository_id: '123',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(crypto.createSecretKey('mock-secret-key', 'ascii'))
})

function post(method: string, messageType: protobuf.Type, payload: object) {
  return fetch(`http://localhost:3000/twirp/github.actions.results.api.v1.CacheService/${method}`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/protobuf',
    },
    body: messageType.encode(messageType.fromObject(payload)).finish() as BodyInit,
  })
}

async function decode<T>(response: Response, messageType: protobuf.Type) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  return messageType.toObject(messageType.decode(bytes), { longs: String, defaults: true }) as T
}

test('protobuf CreateCacheEntry request is accepted and answered in protobuf', async () => {
  const response = await post('CreateCacheEntry', CreateReq, {
    metadata: { repository_id: '123' },
    key: 'protobuf-key',
    version: 'v1',
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/protobuf')

  const body = await decode<{ ok: boolean; signed_upload_url: string }>(response, CreateRes)
  expect(body.ok).toBe(true)
  expect(body.signed_upload_url).toContain('/devstoreaccount1/upload/')
})

test('protobuf GetCacheEntryDownloadURL decodes restore_keys and reports a miss', async () => {
  const response = await post('GetCacheEntryDownloadURL', GetReq, {
    metadata: { repository_id: '123' },
    key: 'no-such-key',
    restore_keys: ['fallback-a', 'fallback-b'],
    version: 'v1',
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/protobuf')

  const body = await decode<{ ok: boolean }>(response, GetRes)
  expect(body.ok).toBe(false)
})

test('protobuf FinalizeCacheEntryUpload decodes the body (missing upload → 404, not 400)', async () => {
  const response = await post('FinalizeCacheEntryUpload', FinalizeReq, {
    metadata: { repository_id: '123' },
    key: 'never-uploaded',
    size_bytes: '4096',
    version: 'v1',
  })

  // 404 (not 400) proves the protobuf body parsed and validated successfully.
  expect(response.status).toBe(404)
})
