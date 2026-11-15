import type { APIRoute } from 'astro'
import { getDocs, markdownResponse, toMarkdown } from '../markdown'

export const GET: APIRoute = async () =>
  markdownResponse((await getDocs()).map(toMarkdown).join('\n\n---\n\n'))
