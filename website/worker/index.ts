/**
 * Serves the static site, and the Markdown version of a page to clients that ask for it with
 * `Accept: text/markdown`. HTML responses advertise their Markdown version in a `Link` header.
 */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    const isPage = !/\.\w+$/.test(pathname)
    if (!isPage) return env.ASSETS.fetch(request)

    const markdownPath = pathname === '/' ? '/llms.txt' : `${pathname.replace(/\/$/, '')}.md`
    if (request.headers.get('Accept')?.includes('text/markdown')) {
      const markdown = await env.ASSETS.fetch(new URL(markdownPath, request.url))
      if (markdown.ok) return withHeaders(markdown, { 'Content-Type': 'text/markdown; charset=utf-8' })
    }

    const response = await env.ASSETS.fetch(request)
    if (!response.ok) return response
    return withHeaders(response, { Link: `<${markdownPath}>; rel="alternate"; type="text/markdown"` })
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher }>

function withHeaders(response: Response, headers: Record<string, string>) {
  const result = new Response(response.body, response)
  for (const [name, value] of Object.entries(headers)) result.headers.set(name, value)
  result.headers.append('Vary', 'Accept')
  return result
}
