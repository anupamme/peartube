// End-to-end check of the Android app on a connected phone against an isolated
// tracker (given by --tracker) or a relay's /v1/status (given by --relay).
// A fresh dev-app install lists the entry, opens immersive playback immediately,
// checks both orientations, and returns directly to the library. Engine details
// live under PearTube → Under the Hood → Engine Room; route bytes live in player Info.
// With --private-routing and no --lan, assert that uncached playback moved bytes
// only through private circuits. Writes result.json and screenshots.
//
//   node android/e2e.mjs --serial <adb serial> (--tracker <hex> | --relay http://<relay>:8174) [--lan] [--private-routing] [--apk path] [--out dir]
//
// Taps go through uiautomator's view of the Compose UI (texts and edit fields), so they do
// not depend on the screen's size. The app is com.peartube.app.dev: the debug build by
// default, or a release build made with -Ppeartube.dev, given with --apk. Its data is
// cleared first.
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
    tracker: { type: 'string' },
    lan: { type: 'boolean', default: false },
    'private-routing': { type: 'boolean', default: false },
    apk: { type: 'string', default: path.join(here, 'app/build/outputs/apk/debug/app-debug.apk') },
    out: { type: 'string', default: path.join(here, 'build/e2e') }
  }
})
if (!opts.serial || (!opts.relay && !opts.tracker)) throw new Error('--serial and --tracker or --relay are required')

const pkg = 'com.peartube.app.dev'
const activity = `${pkg}/dev.dioxus.main.MainActivity`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const adb = (...args) => execFileSync('adb', ['-s', opts.serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
const shell = cmd => adb('shell', cmd)
fs.rmSync(opts.out, { recursive: true, force: true })
fs.mkdirSync(opts.out, { recursive: true })
const shot = name => fs.writeFileSync(path.join(opts.out, name), execFileSync('adb', ['-s', opts.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }))

/** The screen's nodes (text, content description, class, centre and size), and its rotation. */
function nodes () {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
  const list = [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
    const attr = name => (tag.match(new RegExp(` ${name}="([^"]*)"`)) || [])[1]?.replace(/&amp;/g, '&') ?? ''
    const [l, t, r, b] = attr('bounds').match(/\d+/g).map(Number)
    return { text: attr('text'), desc: attr('content-desc'), cls: attr('class'), pkg: attr('package'), checked: attr('checked') === 'true', x: (l + r) >> 1, y: (t + b) >> 1, w: r - l, h: b - t }
  })
  list.rotation = Number(xml.match(/<hierarchy rotation="(\d)"/)?.[1] ?? 0)
  return list
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
    const visible = nodes()
    const found = find(visible)
    if (found) return found
    const root = visible.find(n => n.w > 0 && n.h > 0)
    const x = Math.round(root.w * (root.w > root.h ? 0.88 : 0.5))
    shell(`input swipe ${x} ${Math.round(root.h * 0.84)} ${x} ${Math.round(root.h * 0.35)} 300`)
    await sleep(500)
  }
  throw new Error(`Could not scroll to ${what}`)
}

const tap = node => shell(`input tap ${node.x} ${node.y}`)
const checks = {}
const result = { started: new Date().toISOString(), device: shell('getprop ro.product.model').trim(), relay: opts.relay || null, privateRouting: opts['private-routing'], checks }

try {
  const tracker = opts.tracker || (await (await fetch(new URL('/v1/status', opts.relay))).json()).tracker
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
  if (opts.lan || opts['private-routing']) {
    tap(await scrollTo('advanced network options', ns => ns.find(n => n.text === 'Advanced Network & Engine')))
    const lanSwitch = await scrollTo('the LAN switch', ns => ns.find(n => n.text === 'Find relays on this network'))
    if (lanSwitch.checked !== opts.lan) tap(lanSwitch)
    if (opts['private-routing']) {
      const privateSwitch = await scrollTo('the private routing switch', ns => ns.find(n => n.text === 'Private DHT routing'))
      if (!privateSwitch.checked) tap(privateSwitch)
    }
  }
  tap(await scrollTo('Save', ns => ns.find(n => n.text === 'Save')))

  const rowPattern = /^(S\d\dE\d\d\d?|Movie|(?:Play|Resume) S\d\dE\d\d\d?)$/
  await waitFor('entries', ns => ns.find(n => rowPattern.test(n.text)))
  const listed = nodes()
  tap(await waitFor('the PearTube menu', ns => ns.find(n => n.text === 'PearTube')))
  tap(await scrollTo('Engine Room', ns => ns.find(n => n.text === 'Engine Room')))
  const facts = await waitFor('connection facts', ns => ns.find(n => /^\d+ peers · /.test(n.text)))
  checks.listed = /^\d+ peers · /.test(facts.text) && listed.filter(n => rowPattern.test(n.text)).length > 0
  result.facts = facts.text
  if (opts.lan) {
    // "LAN on <address>" once discovery runs; "LAN failed on …" if it threw.
    result.lan = (await waitFor('the LAN line', ns => ns.find(n => n.text.startsWith('LAN ')), 30_000)).text
    checks.lan = result.lan.startsWith('LAN on ')
  }
  shell('input keyevent KEYCODE_BACK') // dismiss Under the Hood before opening a title
  shot('list.png')

  tap(await waitFor('a playable movie or episode', ns => ns.find(n => rowPattern.test(n.text))))
  await sleep(3000)
  if (!nodes().some(n => n.pkg === pkg)) {
    throw new Error('Android fullscreen notice is in front: tap Got it on the phone, then run this again')
  }
  // The picture's node carries the clock ("Video, 0:13 / 2:26:15"): the controls hide 3 s
  // after the last touch, and a UI dump takes about as long.
  const clockPattern = /^Video, ((\d+:)?\d+:\d\d) \/ (\d+:)?\d+:\d\d$/
  const clockOf = ns => ns.find(n => clockPattern.test(n.desc))
  const seconds = node => node.desc.match(clockPattern)[1].split(':').reduce((s, part) => s * 60 + Number(part), 0)
  const clock1 = await waitFor('the player clock', clockOf, 60_000)
  const immediate = await waitFor('vertical fullscreen playback', ns => ns.rotation === 0 && clockOf(ns) && ns, 15_000)
  const initialVideo = clockOf(immediate)
  checks.fullscreen = initialVideo.w >= immediate[0].w * 0.95 && initialVideo.h >= immediate[0].h * 0.95
  async function playerButton (description) {
    for (let i = 0; i < 5; i++) {
      await sleep(3600)
      tap(clockOf(nodes()))
      const button = nodes().find(n => n.desc === description)
      if (button) return button
    }
    throw new Error(`No ${description} button`)
  }
  async function pressPlayerButton (description) {
    const button = await playerButton(description)
    await sleep(3600)
    tap(button) // reveal the hidden HUD
    await sleep(500)
    tap(button)
  }
  if (opts['private-routing']) {
    await pressPlayerButton('Content info')
    const info = await waitFor('content information', ns => ns.find(n => n.text === 'Decoder'))
    checks.info = Boolean(info)
    const metadata = nodes()
    const meta = metadata.findIndex(n => /^(S\d\dE\d\d\d?|Movie) · /.test(n.text))
    if (meta > 0) result.title = `${metadata[meta - 1].text} (${metadata[meta].text.split(' · ')[0]})`
    await scrollTo('private route details', ns => ns.find(n => n.text.includes('Private ↓')))
    const amount = (line, label) => {
      const match = line.match(new RegExp(`${label} ↓ ([\\d.]+) (B|KB|MB|GB)`))
      return match ? Math.round(Number(match[1]) * 1024 ** ({ B: 0, KB: 1, MB: 2, GB: 3 })[match[2]]) : null
    }
    const evidence = await waitFor('uncached private-route transfer', ns => ns.find(n => {
      if (!n.text.includes('Private ↓')) return false
      return (amount(n.text, 'Private') || 0) >= 256 * 1024
    }), 120_000)
    result.routes = {
      privateRxBytes: amount(evidence.text, 'Private'),
      publicRxBytes: amount(evidence.text, 'Public DHT'),
      lanRxBytes: amount(evidence.text, 'LAN')
    }
    checks.privateRoute = result.routes.privateRxBytes >= 256 * 1024 &&
      result.routes.publicRxBytes === 0 && result.routes.lanRxBytes === 0
    shell('input keyevent KEYCODE_BACK') // close only the information panel
  }

  // Frames on the video SurfaceView over 5 s, from SurfaceFlinger.
  shell('dumpsys SurfaceFlinger --timestats -enable -clear')
  await sleep(5000)
  const stats = shell('dumpsys SurfaceFlinger --timestats -dump')
  shell('dumpsys SurfaceFlinger --timestats -disable')
  const layer = stats.split(/\n(?=layerName = )/).find(b => b.startsWith(`layerName = SurfaceView[${pkg}`) && /totalFrames = [1-9]/.test(b))
  result.videoFramesIn5s = Number(layer?.match(/totalFrames = (\d+)/)?.[1] ?? 0)
  checks.video = result.videoFramesIn5s >= 50 // at least 10 fps

  const clock2 = clockOf(nodes())
  result.clock = [clock1.desc.slice(7), clock2?.desc.slice(7)]
  checks.clockAdvances = clock2 != null && seconds(clock2) > seconds(clock1)

  const uid = shell(`dumpsys package ${pkg}`).match(/appId=(\d+)/)[1]
  checks.audio = shell('dumpsys audio').split('\n').some(l => l.includes(`u/pid:${uid}/`) && l.includes('state:started'))
  shot('play.png')

  // The player opens vertically edge-to-edge. Exercise the orientation toggle into landscape
  // and back to vertical via KEYCODE_BACK, retaining full-window and exact HUD-position assertions.
  const back = await playerButton('Back')
  await pressPlayerButton('Toggle orientation')
  const sideways = await waitFor('landscape fullscreen', ns => ns.rotation % 2 === 1 && clockOf(ns) && ns, 15_000)
  shot('fullscreen.png')
  const full = clockOf(sideways)
  result.fullscreen = { video: [full.w, full.h], window: [sideways[0].w, sideways[0].h] }
  checks.fullscreen = checks.fullscreen && full.w >= sideways[0].w * 0.95 && full.h >= sideways[0].h * 0.95
  shell('input keyevent KEYCODE_BACK')
  const upright = await waitFor('vertical fullscreen again', ns => ns.rotation === 0 && clockOf(ns) && ns, 10_000)
  const portraitVideo = clockOf(upright)
  checks.fullscreen = checks.fullscreen && portraitVideo.w >= upright[0].w * 0.95 && portraitVideo.h >= upright[0].h * 0.95
  const backAgain = await playerButton('Back')
  shot('after-fullscreen.png')
  result.back = { before: [back.x, back.y], after: [backAgain.x, backAgain.y] }
  checks.backInPlace = Math.abs(backAgain.x - back.x) <= 2 && Math.abs(backAgain.y - back.y) <= 2
  shell('input keyevent KEYCODE_BACK')
  await waitFor('portrait library', ns => ns.rotation === 0, 10_000)
  checks.backToList = Boolean(await waitFor('the list again', ns => ns.find(n => n.text === 'PearTube'), 15_000))
} catch (err) {
  result.error = String(err?.stack || err)
}

const expected = ['listed', ...(opts.lan ? ['lan'] : []), ...(opts['private-routing'] ? ['privateRoute'] : []), 'video', 'clockAdvances', 'audio', 'fullscreen', 'backInPlace', 'backToList']
result.passed = !result.error && expected.every(name => checks[name] === true)
result.finished = new Date().toISOString()
fs.writeFileSync(path.join(opts.out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.passed ? 0 : 1
