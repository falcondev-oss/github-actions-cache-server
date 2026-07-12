import type { H3Event } from 'h3'
import type { z } from 'zod'

import protobuf from 'protobufjs'

// Twirp CacheService messages. Only the fields the server reads/writes are
// declared; protobuf skips unknown fields (e.g. `metadata`) on decode.
const root = protobuf.parse(
  `
  syntax = "proto3";
  package github.actions.results.api.v1;

  message CreateCacheEntryRequest { string key = 2; string version = 3; }
  message CreateCacheEntryResponse { bool ok = 1; string signed_upload_url = 2; string message = 3; }

  message FinalizeCacheEntryUploadRequest { string key = 2; int64 size_bytes = 3; string version = 4; }
  message FinalizeCacheEntryUploadResponse { bool ok = 1; int64 entry_id = 2; string message = 3; }

  message GetCacheEntryDownloadURLRequest { string key = 2; repeated string restore_keys = 3; string version = 4; }
  message GetCacheEntryDownloadURLResponse { bool ok = 1; string signed_download_url = 2; string matched_key = 3; }
`,
  { keepCase: true },
).root

function lookup(name: string) {
  return root.lookupType(`github.actions.results.api.v1.${name}`)
}

export const TwirpMessage = {
  CreateCacheEntryRequest: lookup('CreateCacheEntryRequest'),
  CreateCacheEntryResponse: lookup('CreateCacheEntryResponse'),
  FinalizeCacheEntryUploadRequest: lookup('FinalizeCacheEntryUploadRequest'),
  FinalizeCacheEntryUploadResponse: lookup('FinalizeCacheEntryUploadResponse'),
  GetCacheEntryDownloadURLRequest: lookup('GetCacheEntryDownloadURLRequest'),
  GetCacheEntryDownloadURLResponse: lookup('GetCacheEntryDownloadURLResponse'),
}

const PROTOBUF_CONTENT_TYPE = 'application/protobuf'

// Twirp negotiates its wire format via Content-Type; a protobuf request must
// get a protobuf response. Anything that isn't explicitly protobuf is treated
// as JSON, preserving the behavior of the GitHub runner's JSON-only client.
function isProtobuf(event: H3Event) {
  return getHeader(event, 'content-type')?.includes(PROTOBUF_CONTENT_TYPE) ?? false
}

export async function readTwirpRequest<T>(
  event: H3Event,
  schema: z.ZodType<T>,
  messageType: protobuf.Type,
): Promise<T> {
  let body: unknown
  if (isProtobuf(event)) {
    const raw = await readRawBody(event, false)
    body = raw
      ? messageType.toObject(messageType.decode(raw), { longs: String, defaults: true })
      : {}
  } else {
    body = await readBody(event)
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsed.error.message}`,
    })

  return parsed.data
}

export function sendTwirpResponse(event: H3Event, data: object, messageType: protobuf.Type) {
  if (!isProtobuf(event)) return data

  const err = messageType.verify(data)
  if (err) throw createError({ statusCode: 500, statusMessage: `Invalid Twirp response: ${err}` })

  setResponseHeader(event, 'content-type', PROTOBUF_CONTENT_TYPE)
  return Buffer.from(messageType.encode(messageType.fromObject(data)).finish())
}
