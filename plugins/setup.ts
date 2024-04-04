// eslint-disable-next-line ts/no-misused-promises
export default defineNitroPlugin(async () => {
  await import('@/lib/env')
  await import('@/lib/db')
})
