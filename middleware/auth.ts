export default defineEventHandler((event) => {
  // /download handles authentication differently
  if (event.path.startsWith('/download')) return

  const authHeader = getHeader(event, 'authorization')
  if (!authHeader) throw createError({ statusCode: 401 })

  const [type, token] = authHeader.split(' ')
  if (type !== 'Bearer' || token !== ENV.ACTIONS_RUNTIME_TOKEN)
    throw createError({ statusCode: 401 })
})
