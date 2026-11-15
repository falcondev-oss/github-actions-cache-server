/** Docs pages by section, shared by the sidebar and `llms.txt`. */
export const sections = [
  {
    label: 'Start here',
    items: ['getting-started', 'configuration', 'how-it-works', 'troubleshooting', 'faq'],
  },
  {
    label: 'Guides',
    items: [
      'guides/ephemeral-runners-local-cache',
      'guides/actions-runner-controller',
      'guides/github-actions-cache-options',
      'guides/github-enterprise-server',
    ],
  },
  {
    label: 'Storage drivers',
    items: [
      'storage-drivers',
      'storage-drivers/file-system',
      'storage-drivers/s3',
      'storage-drivers/google-cloud-storage',
      'storage-drivers/azure-blob-storage',
    ],
  },
  {
    label: 'Database drivers',
    items: [
      'database-drivers',
      'database-drivers/sqlite',
      'database-drivers/postgres',
      'database-drivers/mysql',
    ],
  },
  { label: 'Operations', items: ['metrics', 'benchmarks'] },
] as const satisfies { label: string; items: string[] }[]
