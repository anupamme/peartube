// End-to-end check of the Android app on a connected phone, against a live relay:
// a fresh install joins the relay's tracker through the Settings screen, lists its
// entries, plays the first one through the Rust player, and comes back to the list.
// Writes result.json and screenshots, and exits non-zero when a check fails.
//
//   node android/e2e.mjs --serial <adb serial> --relay http://<relay>:8174 [--lan] [--apk path] [--out dir]
//
// Taps go through uiautomator's view of the Compose UI (texts and edit fields), so they do
// not depend on the screen's size. The app is the debug build, com.peartube.app.dev; its
// data is cleared first.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))
const { values: opts } = parseArgs({
  options: {
    serial: { type: 'string' },
    relay: { type: 'string' },
    lan: { type: 'boolean', default: false },
    apk: { type: 'string', default: path.join(here, 'app/build/outputs/apk/debug/app-debug.apk') },
    out: { type: 'string', default: path.join(here, 'build/e2e') }
  }
})
if (!opts.serial || !opts.relay) throw new Error('--serial and --relay are required')

const pkg = 'com.peartube.app.dev'
const activity = `${pkg}/dev.dioxus.main.MainActivity`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const adb = (...args) => execFileSync('adb', ['-s', opts.serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
const shell = cmd => adb('shell', cmd)
fs.rmSync(opts.out, { recursive: true, force: true })
fs.mkdirSync(opts.out, { recursive: true })
const shot = name => fs.writeFileSync(path.join(opts.out, name), execFileSync('adb', ['-s', opts.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }))

/** The screen's nodes: text, class, and the centre of their bounds. */
function nodes () {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
  return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
    const attr = name => (tag.match(new RegExp(` ${name}="([^"]*)"`)) || [])[1] ?? ''
    const [l, t, r, b] = attr('bounds').match(/\d+/g).map(Number)
    return { text: attr('text').replace(/&amp;/g, '&'), cls: attr('class'), x: (l + r) >> 1, y: (t + b) >> 1 }
  })
}

async function waitFor (what, find, timeout = 120_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const found = find(nodes())
    if (found) return found
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Scrolls a form down until [find] matches, for controls below the fold. */
async function scrollTo (what, find) {
  for (let i = 0; i < 6; i++) {
    const found = find(nodes())
    if (found) return found
    shell('input swipe 540 1800 540 900 300')
    await sleep(500)
  }
  throw new Error(`Could not scroll to ${what}`)
}

const tap = node => shell(`input tap ${node.x} ${node.y}`)
const checks = {}
const result = { started: new Date().toISOString(), device: shell('getprop ro.product.model').trim(), relay: opts.relay, checks }

try {
  const tracker = (await (await fetch(new URL('/v1/status', opts.relay))).json()).tracker
  result.tracker = tracker.slice(0, 8)
  result.apk = { sha256: createHash('sha256').update(fs.readFileSync(opts.apk)).digest('hex') }

  adb('install', '-r', opts.apk)
  shell(`pm clear ${pkg}`)
  shell('input keyevent KEYCODE_WAKEUP')
  shell(`am start -W -n ${activity}`)
  result.apk.version = shell(`dumpsys package ${pkg}`).match(/versionName=(\S+)/)?.[1]

  // First run opens Settings.
  const field = await waitFor('the tracker field', ns => ns.find(n => n.cls === 'android.widget.EditText'), 30_000)
  tap(field)
  shell(`input text ${tracker}`)
  shell('input keyevent KEYCODE_BACK') // hides the keyboard
  if (opts.lan) tap(await scrollTo('the LAN switch', ns => ns.find(n => n.text === 'Find relays on this network')))
  tap(await scrollTo('Save', ns => ns.find(n => n.text === 'Save')))

  const rowPattern = /^(S\d\dE\d\d\d?|Movie)$/
  const firstRow = await waitFor('entries', ns => ns.find(n => rowPattern.test(n.text)))
  const listed = nodes()
  checks.listed = listed.some(n => /^\d+ peers · /.test(n.text)) && listed.filter(n => rowPattern.test(n.text)).length > 0
  result.facts = listed.find(n => /^\d+ peers · /.test(n.text))?.text
  shot('list.png')

  tap(firstRow)
  const clockPattern = /^(\d+:)?\d+:\d\d \/ (\d+:)?\d+:\d\d$/
  const seconds = text => text.split(' / ')[0].split(':').reduce((s, part) => s * 60 + Number(part), 0)
  const clock1 = await waitFor('the player clock', ns => ns.find(n => clockPattern.test(n.text)), 60_000)
  result.title = nodes().find(n => / \((S\d\dE\d\d\d?|Movie)\)$/.test(n.text))?.text

  // Frames on the video SurfaceView over 5 s, from SurfaceFlinger.
  shell('dumpsys SurfaceFlinger --timestats -enable -clear')
  await sleep(5000)
  const stats = shell('dumpsys SurfaceFlinger --timestats -dump')
  shell('dumpsys SurfaceFlinger --timestats -disable')
  const layer = stats.split(/\n(?=layerName = )/).find(b => b.startsWith(`layerName = SurfaceView[${pkg}`) && /totalFrames = [1-9]/.test(b))
  result.videoFramesIn5s = Number(layer?.match(/totalFrames = (\d+)/)?.[1] ?? 0)
  checks.video = result.videoFramesIn5s >= 50 // at least 10 fps

  const clock2 = nodes().find(n => clockPattern.test(n.text))
  result.clock = [clock1.text, clock2?.text]
  checks.clockAdvances = clock2 != null && seconds(clock2.text) > seconds(clock1.text)

  const uid = shell(`dumpsys package ${pkg}`).match(/appId=(\d+)/)[1]
  checks.audio = shell('dumpsys audio').split('\n').some(l => l.includes(`u/pid:${uid}/`) && l.includes('state:started'))
  shot('play.png')

  shell('input keyevent KEYCODE_BACK')
  checks.backToList = Boolean(await waitFor('the list again', ns => ns.find(n => n.text === 'PearTube'), 15_000))
} catch (err) {
  result.error = String(err?.stack || err)
}

result.passed = !result.error && Object.values(checks).length === 5 && Object.values(checks).every(Boolean)
result.finished = new Date().toISOString()
fs.writeFileSync(path.join(opts.out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.passed ? 0 : 1
