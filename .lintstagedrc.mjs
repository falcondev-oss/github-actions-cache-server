const runInPackage = undefined // replace with package name, eg: '@company/package'
const pnpmExec = runInPackage ? `pnpm --filter ${runInPackage} exec ` : ''

export default {
  '*.{vue,?([cm])[jt]s?(x),y?(a)ml,json?(c),md,html,?(s)css}': [
    `${pnpmExec}eslint --fix --cache`,
    `${pnpmExec}prettier --write --cache`,
  ],
  '*.{vue,?([cm])ts?(x)}': () => `${pnpmExec}tsc -p tsconfig.json --noEmit --composite false`, // run once for all files
}
