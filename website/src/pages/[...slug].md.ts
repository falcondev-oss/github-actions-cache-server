import type { APIRoute, GetStaticPaths, InferGetStaticPropsType } from 'astro'
import { getDocs, markdownResponse, toMarkdown } from '../markdown'

export const getStaticPaths = (async () =>
  (await getDocs()).map((doc) => ({ params: { slug: doc.id }, props: { doc } }))) satisfies GetStaticPaths

export const GET: APIRoute<InferGetStaticPropsType<typeof getStaticPaths>> = ({ props }) =>
  markdownResponse(toMarkdown(props.doc))
