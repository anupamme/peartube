#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ios = dirname(fileURLToPath(import.meta.url))
const root = dirname(ios)
const platform = process.argv[2] || 'iphonesimulator'
if (!['iphoneos', 'iphonesimulator'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`)
const host = platform === 'iphoneos' ? 'ios-arm64' : 'ios-arm64-simulator'
const target = platform === 'iphoneos' ? 'aarch64-apple-ios' : 'aarch64-apple-ios-sim'
const out = join(ios, 'build', platform)
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: 'inherit', ...options })
mkdirSync(out, { recursive: true })
if (!existsSync(join(root, 'worklet/vendor/bare-kit', host, 'BareKit.framework'))) run('sh', ['worklet/bare-kit.sh', host])

const digest = createHash('sha256').update(host)
function hash(path) {
  if (['vendor', 'node_modules'].includes(path.split('/').at(-1))) return
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(path, entry.name)
    if (entry.isDirectory()) hash(name)
    else digest.update(name).update(readFileSync(name))
  }
}
hash(join(root, 'src'))
hash(join(root, 'worklet'))
for (const name of ['package.json', 'package-lock.json', 'ios/bonjour.cjs', 'ios/prepare.mjs']) digest.update(readFileSync(join(root, name)))
const stamp = digest.digest('hex')
const stampPath = join(out, 'worklet.sha256')
if (!existsSync(stampPath) || readFileSync(stampPath, 'utf8') !== stamp) {
  const imports = { ...JSON.parse(readFileSync(join(root, 'worklet/imports.json'))), 'bonjour-service': pathToFileURL(join(ios, 'bonjour.cjs')).href }
  const importsPath = join(out, 'imports.json')
  const bundle = join(out, 'worker.bundle')
  writeFileSync(importsPath, JSON.stringify(imports))
  run('node', ['node_modules/bare/bin/bare', 'worklet/pack.cjs', '--linked', '--host', host, '--imports', importsPath, '--out', bundle, 'worklet/worker.js'])
  const bytes = readFileSync(bundle)
  const newline = bytes.indexOf(10)
  const length = Number(bytes.subarray(0, newline).toString())
  const header = JSON.parse(bytes.subarray(newline, newline + length).toString())
  const frameworks = join(out, 'Frameworks')
  rmSync(frameworks, { recursive: true, force: true })
  mkdirSync(frameworks, { recursive: true })
  const packages = new Set()
  for (const [file, imports] of Object.entries(header.resolutions)) {
    if (imports?.['.']?.addon?.startsWith('linked:')) packages.add(resolve(root, dirname(file.replace(/^\//, ''))))
  }
  for (const pkg of packages) run('node', ['node_modules/bare-link/bin.js', '--host', host, '--out', frameworks, pkg])
  cpSync(join(root, 'worklet/vendor/bare-kit', host, 'BareKit.framework'), join(frameworks, 'BareKit.framework'), { recursive: true })
  writeFileSync(stampPath, stamp)
}
run('cargo', ['build', '--manifest-path', 'ios/native/Cargo.toml', '--target', target, '--release'], {
  env: { ...process.env, CARGO_TARGET_DIR: join(ios, 'build/cargo'), IPHONEOS_DEPLOYMENT_TARGET: '17.0' }
})
cpSync(join(ios, 'build/cargo', target, 'release/libpeartube_ios.a'), join(out, 'libpeartube_ios.a'))
console.log(`Prepared ${host} worklet, addons, and shared Rust player in ${out}`)
