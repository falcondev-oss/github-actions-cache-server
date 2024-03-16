// @ts-check
import _eslintConfig from '@louishaftmann/eslint-config'

const eslintConfig = await _eslintConfig({
  nuxt: false,
})

/** @type {import('eslint').Linter.FlatConfig} */
const ignores = {
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
}

export default [...eslintConfig, ignores]
