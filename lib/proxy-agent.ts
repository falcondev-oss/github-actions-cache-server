import { ProxyAgent } from 'undici'

let proxyUrl: string | undefined
let proxyAgent: ProxyAgent | undefined
let noProxyPatterns: string[] = []

function refreshConfig() {
  proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy

  const raw = process.env.NO_PROXY || process.env.no_proxy || ''
  noProxyPatterns = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  if (proxyUrl) {
    proxyAgent = new ProxyAgent(proxyUrl, {
      connect: {
        rejectUnauthorized: false,
      },
    })
  } else {
    proxyAgent = undefined
  }
}

function matchesNoProxy(hostname: string): boolean {
  if (noProxyPatterns.length === 0) {
    return false
  }
  const h = hostname.toLowerCase()
  return noProxyPatterns.some((pattern) => {
    if (pattern === '*') {
      return true
    }
    if (pattern.startsWith('.')) {
      return h === pattern.slice(1) || h.endsWith(pattern)
    }
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      )
      return regex.test(h)
    }
    return h === pattern || h.endsWith('.' + pattern)
  })
}

export function getProxyDispatcher(url: string) {
  refreshConfig()

  if (!proxyUrl) {
    return undefined
  }

  const hostname = new URL(url).hostname
  if (matchesNoProxy(hostname)) {
    return undefined
  }

  return proxyAgent
}
