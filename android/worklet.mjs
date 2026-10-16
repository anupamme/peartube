// Builds the Android app's P2P worklet, as desktop/build.rs does for the Mac
// app: packs worklet/worker.js with bare-pack for android-arm64, links every
// native addon the bundle loads with bare-link, and puts them next to
// bare-kit's own libraries (built by worklet/bare-kit.sh) for the APK.
//
//   node android/worklet.mjs <assets dir> <jniLibs dir> <scratch dir>
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const worklet = path.join(root, 'worklet')
const [assets, jniLibs, scratch] = process.argv.slice(2).map(dir => path.resolve(dir))
const host = 'android-arm64'
const abi = 'arm64-v8a'

const kit = path.join(worklet, 'vendor/bare-kit/android', abi)
if (!fs.existsSync(path.join(kit, 'libbare-kit.so'))) {
  throw new Error(`bare-kit is not built for ${abi}: run sh worklet/bare-kit.sh ${abi}`)
}

for (const dir of [assets, jniLibs, scratch]) fs.rmSync(dir, { recursive: true, force: true })
const libs = path.join(jniLibs, abi)
fs.mkdirSync(assets, { recursive: true })
fs.mkdirSync(libs, { recursive: true })

// bare-pack runs under Bare (worklet/pack.cjs); its lexer addon crashes under Node 22.
const run = (...args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
const bundle = path.join(assets, 'worker.bundle')
run(path.join(root, 'node_modules/bare/bin/bare'), path.join(worklet, 'pack.cjs'),
  '--linked', '--host', host, '--imports', path.join(worklet, 'imports.json'),
  '--out', bundle, path.join(worklet, 'worker.js'))

// The bundle starts with "<len>\n<json>\n", len counting both newlines. Its
// resolutions map each addon's binding.js, at the package root, to a
// `linked:` library.
const bytes = fs.readFileSync(bundle)
const newline = bytes.indexOf(10)
const len = Number(bytes.subarray(0, newline).toString())
const header = JSON.parse(bytes.subarray(newline, newline + len).toString())
for (const [file, imports] of Object.entries(header.resolutions)) {
  if (imports['.']?.addon?.startsWith('linked:')) {
    run(path.join(root, 'node_modules/bare-link/bin.js'), '--host', host, '--out', scratch, path.join(root, path.dirname(file)))
  }
}

const linked = path.join(scratch, abi)
for (const name of fs.existsSync(linked) ? fs.readdirSync(linked) : []) {
  fs.copyFileSync(path.join(linked, name), path.join(libs, name))
}
for (const name of ['libbare-kit.so', 'libc++_shared.so']) {
  fs.copyFileSync(path.join(kit, name), path.join(libs, name))
}
