import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { sections } from './src/sidebar'

const site = 'https://gha-cache-server.falcondev.io'
const repo = 'https://github.com/falcondev-oss/github-actions-cache-server'

export default defineConfig({
  site,
  // pages live at `/getting-started`, the URLs the old docs used; see `html_handling` in wrangler.jsonc
  trailingSlash: 'never',
  integrations: [
    starlight({
      title: 'GitHub Actions Cache Server',
      description:
        'Self-hosted GitHub Actions cache server written in Rust. Drop-in replacement for the GitHub cache backend: actions/cache, setup-* caches and BuildKit type=gha work unchanged on self-hosted and ephemeral runners.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/dev/website/` },
      lastUpdated: true,
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/theme.css',
      ],
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '0.375rem',
          codeFontFamily: 'var(--sl-font-mono)',
          frames: { shadowColor: 'transparent' },
        },
      },
      components: {
        Head: './src/components/Head.astro',
        PageTitle: './src/components/PageTitle.astro',
      },
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${site}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      sidebar: sections.map(({ label, items }) => ({ label, items: [...items] })),
    }),
  ],
})
