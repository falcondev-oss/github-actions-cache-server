import type { RPCLinkOptions } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'
import type { router } from '~/routes/management-api/[...]'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'

/**
 * @param apiBaseUrl Base URL of the cache server (e.g. http://localhost:3000)
 * @param apiKey API key for the management API (must match MANAGEMENT_API_KEY on the server)
 * @param options Additional options for the RPC link
 */
export function createClient(
  apiBaseUrl: string,
  apiKey: string,
  options?: Omit<RPCLinkOptions<any>, 'url'>,
): RouterClient<typeof router> {
  const link = new RPCLink({
    ...options,
    headers: {
      'X-Api-Key': apiKey,
      ...options?.headers,
    },
    url: `${apiBaseUrl}/management-api/_rpc`,
  })

  return createORPCClient(link)
}
