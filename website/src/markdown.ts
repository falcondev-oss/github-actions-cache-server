import { getCollection, type CollectionEntry } from 'astro:content'

export type Doc = CollectionEntry<'docs'>

const site = import.meta.env.SITE

/** Every docs page except the landing page. */
export async function getDocs() {
  const docs = await getCollection('docs', ({ id }) => id !== 'index')
  return docs.sort((a, b) => a.id.localeCompare(b.id))
}

export const pageUrl = (id: string) => `${site}/${id}`
export const markdownUrl = (id: string) => `${site}/${id}.md`

/** Points links to other pages at their Markdown version, so an agent can follow them. */
const linkMarkdown = (body: string) =>
  body.replaceAll(/\]\(\/([\w/-]+)(#[\w-]+)?\)/g, (_, path: string, hash = '') => `](${markdownUrl(path)}${hash})`)

/** The page as an agent reads it: title, summary, then the Markdown source. */
export const toMarkdown = ({ id, data, body = '' }: Doc) =>
  `# ${data.title}\n\n> ${data.description}\n\nSource: ${pageUrl(id)}\n\n${linkMarkdown(body)}`

export const markdownResponse = (text: string) =>
  new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
