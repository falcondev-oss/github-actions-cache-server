// @ts-check
import _eslintConfig from '@louishaftmann/eslint-config'

const eslintConfig = await _eslintConfig({
  nuxt: false,
  tsconfigPath: ['./tsconfig.json'],
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
  ],
}

export default [...eslintConfig, ignores]
