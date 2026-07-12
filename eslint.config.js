// @ts-check
import eslintConfig from '@falcondev-oss/configs/eslint'

export default eslintConfig({
  nuxt: false,
})
  .append({
    files: ['routes/**/*.*', 'CONTEXT.md', 'AGENTS.md', 'CLAUDE.md'],
    rules: {
      'unicorn/filename-case': 'off',
    },
  })
  .append({
    rules: {
      'compat/compat': 'off',
      'node/prefer-global/buffer': 'off',
    },
  })
  .append({
    ignores: [
      'install/',
      '.prettierrc.cjs',
      '.lintstagedrc.mjs',
      'node_modules/',
      'dist/',
      '.nuxt/',
      '.output/',
      '.temp/',
    ],
  })
