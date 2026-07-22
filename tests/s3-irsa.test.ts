import { describe, expect, test } from 'vitest'
import { envSchema } from '~/lib/schemas'

const baseEnv = {
  API_BASE_URL: 'http://localhost:3000',
  DB_DRIVER: 'sqlite',
  DB_SQLITE_PATH: 'tests/temp/vitest.sqlite',
  STORAGE_DRIVER: 's3',
  STORAGE_S3_BUCKET: 'vitest',
  STORAGE_S3_SOCKET_TIMEOUT_MS: 10_000,
  AWS_REGION: 'us-east-1',
} as const

describe.skipIf(process.env.VITEST_STORAGE_DRIVER !== 's3')('test S3 IRSA authentication', () => {
  test('accepts AWS Web Identity environment variables', () => {
    expect(() =>
      envSchema.assert({
        ...baseEnv,
        AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/github-actions-cache-server',
        AWS_ROLE_SESSION_NAME: 'github-actions-cache-server',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/eks.amazonaws.com/serviceaccount/token',
      }),
    ).not.toThrow()
  })

  test('requires Web Identity settings', () => {
    expect(() =>
      envSchema.assert({
        ...baseEnv,
        AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/github-actions-cache-server',
      }),
    ).toThrow()
  })
})
