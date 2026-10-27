// Pack and link the same module graph, with identical builtin overrides.
// bare-link 4's public API accepts imports (its CLI does not).
// https://github.com/holepunchto/bare-pack#linking
// https://github.com/holepunchto/bare-link/blob/v4.1.0/index.d.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [host, bundlePath, addonsPath, importsPath = join(root, 'worklet/imports.json')] = process.argv.slice(2)
const bundle = resolve(bundlePath)
const addons = resolve(addonsPath)
const importsFile = resolve(importsPath)
const entry = join(root, 'worklet/worker.js')

mkdirSync(dirname(bundle), { recursive: true })
execFileSync(process.execPath, [join(root, 'node_modules/bare/bin/bare'), join(root, 'worklet/pack.cjs'),
  '--linked', '--host', host, '--base', root, '--imports', importsFile,
  '--out', bundle, entry], { cwd: root, stdio: 'inherit' })

rmSync(addons, { recursive: true, force: true })
mkdirSync(addons, { recursive: true })
execFileSync(process.execPath, [join(root, 'node_modules/bare/bin/bare'), join(root, 'worklet/pack.cjs'),
  '--link', host, addons, importsFile, entry], { cwd: root, stdio: 'inherit' })
