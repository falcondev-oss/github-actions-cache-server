// @ts-check
import eslintConfig from '@louishaftmann/eslint-config'

export default eslintConfig({
  nuxt: false,
  unicorn: true,
})
  .append({
    files: ['routes/**/*.*'],
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
      '.prettierrc.cjs',
      '.lintstagedrc.mjs',
      'node_modules/',
      'dist/',
      '.nuxt/',
      '.output/',
      '.temp/',
      'docs/',
    ],
  })
