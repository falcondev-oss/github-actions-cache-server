export default defineAppConfig({
  ui: {
    primary: 'violet',
    gray: 'zinc',
    footer: {
      bottom: {
        left: 'text-sm text-gray-500 dark:text-gray-400',
        wrapper: 'border-t border-gray-200 dark:border-gray-800',
      },
    },
  },
  seo: {
    siteName: 'GitHub Actions Cache Server',
  },
  header: {
    logo: {
      alt: '',
      light: '',
      dark: '',
    },
    search: true,
    colorMode: true,
    links: [
      {
        'icon': 'i-simple-icons-github',
        'to': 'https://github.com/falcondev-it/github-actions-cache-server',
        'target': '_blank',
        'aria-label': 'Github Actions Cache Server on GitHub',
      },
    ],
  },
  footer: {
    credits: 'Copyright © 2024',
    colorMode: false,
    links: [
      {
        'icon': 'i-simple-icons-github',
        'to': 'https://github.com/falcondev-it/github-actions-cache-server',
        'target': '_blank',
        'aria-label': 'Github Actions Cache Server on GitHub',
      },
    ],
  },
  toc: {
    title: 'Table of Contents',
    bottom: {
      title: 'Community',
      edit: 'https://github.com/nuxt-ui-pro/docs/edit/main/content',
      links: [
        {
          icon: 'i-heroicons-star',
          label: 'Star on GitHub',
          to: 'https://github.com/falcondev-it/github-actions-cache-server',
          target: '_blank',
        },
      ],
    },
  },
})
