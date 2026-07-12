import type { IncomingHttpHeaders } from 'node:http'

import http from 'node:http'

export interface CapturedResultsRequest {
  body: string
  headers: IncomingHttpHeaders
  method: string | undefined
  url: string | undefined
}

export async function startResultsOrigin() {
  const requests: CapturedResultsRequest[] = []
  const server = http.createServer(async (request, response) => {
    if (request.url === '/_test/requests') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(requests))
      return
    }

    const bodyChunks: Buffer[] = await Array.fromAsync(request)
    requests.push({
      body: Buffer.concat(bodyChunks).toString(),
      headers: request.headers,
      method: request.method,
      url: request.url,
    })

    response.statusCode = 409
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('x-results-origin', 'fake')
    response.end('{"code":"already_exists","msg":"artifact already exists"}')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new TypeError('Fake Results origin did not bind to a TCP port')

  return { server, url: `http://127.0.0.1:${address.port}` }
}
