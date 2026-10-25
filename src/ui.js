// Single-page dashboard for relays & local client daemons; textContent guards every peer string.
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearTube</title>
<style>
  :root { color-scheme: dark; --bg: #0f1115; --card: #171a21; --line: #262b36; --text: #e6e8ee; --dim: #8a91a3; --brand: #4c8dff; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 18px; margin: 0 0 6px; display: flex; justify-content: space-between; align-items: center; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; margin: 20px 0 8px; }
  .facts { color: var(--dim); margin-bottom: 14px; display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
  .facts b { color: var(--text); font-weight: 600; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; }
  .row { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
  .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--dim); font-size: 12px; margin-top: 3px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: #2a2f3a; white-space: nowrap; }
  .running, .announcing { background: #1d3b66; } .done, .seeder { background: #1b4d32; } .failed { background: #5c1f24; }
  .bar { height: 4px; background: var(--line); border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--brand); }
  .error { color: #ff8a8a; font-size: 12px; margin-top: 4px; }
  .empty { color: var(--dim); padding: 12px 0; }
  input, select { background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit; }
  button, a.btn { background: #262b36; color: var(--text); border: 1px solid #363d4d; border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; text-decoration: none; }
  button.primary { background: #22498a; border-color: var(--brand); color: #fff; }
  button:hover:not(:disabled), a.btn:hover { background: #323947; }
  button.primary:hover:not(:disabled) { background: #2d5cb0; }
  button:disabled { opacity: .45; cursor: default; }
  #playerModal { position: fixed; inset: 0; background: rgba(7, 9, 13, .95); z-index: 100; display: none; flex-direction: column; }
  #playerModal.open { display: flex; }
  .p-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 18px; background: rgba(15, 17, 21, .9); border-bottom: 1px solid var(--line); }
  .p-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; overflow: hidden; cursor: pointer; }
  #pVideo, #pGlCanvas, #pCanvas { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: none; }
  #pSubCanvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  #pSubText { position: absolute; left: 8%; right: 8%; bottom: 28px; text-align: center; font-size: clamp(16px, 2.2vw, 28px); font-weight: 600; color: #fff; text-shadow: 0 2px 6px #000, 0 0 3px #000, 1px 1px 0 #000, -1px -1px 0 #000; white-space: pre-wrap; pointer-events: none; }
  #pStatus { position: absolute; padding: 8px 14px; border-radius: 8px; background: rgba(15, 17, 21, .82); border: 1px solid var(--line); color: var(--text); font-size: 13px; pointer-events: none; display: none; }
  .p-bar { padding: 10px 18px 14px; background: rgba(15, 17, 21, .94); border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  #pSeek { width: 100%; accent-color: var(--brand); padding: 0; cursor: pointer; }
  .clock { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--dim); min-width: 96px; }
</style>
</head>
<body>
<main>
  <h1><span>PearTube</span><span><a class="btn" href="/manifest.json" target="_blank">Stremio Manifest</a> <a class="btn" href="/v1/playlist.m3u">M3U Playlist</a></span></h1>
  <div class="facts" id="facts"></div>
  <form class="row" id="addForm" style="margin-bottom:14px">
    <input id="uriInput" style="flex:1;min-width:220px" placeholder="Paste 64-hex key or peartube://channel/... or peartube://watch/..." required>
    <select id="kindSelect"><option value="channel">Channel</option><option value="tracker">Open Tracker</option></select>
    <input id="aliasInput" style="width:140px" placeholder="Optional name">
    <button type="submit">Add / Open</button>
  </form>
  <div id="err" class="error"></div>
  <h2>Channels & Trackers</h2>
  <div id="sources"></div>
  <div id="discoveredWrap" style="display:none"><h2>Discovered via Gossip</h2><div id="discovered"></div></div>
  <h2>Catalog</h2>
  <div id="entries"></div>
  <div id="pluginsWrap" style="display:none"><h2>Mirror Plugins</h2><div id="plugins"></div></div>
  <h2>Acquisitions</h2>
  <div id="jobs"></div>
</main>
<div id="playerModal">
  <div class="p-top">
    <div class="row" style="min-width:0;flex:1">
      <span class="title" id="pTitle"></span>
      <span class="badge running" id="pBadge">Loading WASM…</span>
    </div>
    <div class="row">
      <a class="btn" id="pRawLink" target="_blank" rel="noopener">Raw URL</a>
      <button id="pFsBtn">Fullscreen</button>
      <button id="pCloseBtn">Close</button>
    </div>
  </div>
  <div class="p-stage" id="pStage">
    <video id="pVideo" muted playsinline></video>
    <canvas id="pGlCanvas"></canvas>
    <canvas id="pCanvas"></canvas>
    <canvas id="pSubCanvas"></canvas>
    <div id="pSubText"></div>
    <div id="pStatus"></div>
  </div>
  <div class="p-bar">
    <input type="range" id="pSeek" min="0" max="1000" value="0" step="1">
    <div class="row">
      <div class="row">
        <button class="primary" id="pPlayBtn">Pause</button>
        <button id="pBackBtn">-10s</button>
        <button id="pFwdBtn">+10s</button>
        <span class="clock" id="pClock">0:00 / 0:00</span>
      </div>
      <div class="row">
        <select id="pAudioSel" title="Audio Track"></select>
        <select id="pSubSel" title="Subtitles"></select>
        <button id="pMuteBtn">Mute</button>
        <input type="range" id="pVol" min="0" max="100" value="100" style="width:80px;padding:0;accent-color:var(--brand)" title="Volume">
      </div>
    </div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id)
const el = (t, c, txt) => { const e = document.createElement(t); if (t === 'button') e.type = 'button'; if (c) e.className = c; if (txt != null) e.textContent = txt; return e }
const size = n => n == null ? '' : n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B'
const fact = (k, v) => { const s = el('span', null, k + ' '); s.append(el('b', null, v)); return s }
// Stuffs the URI down a hidden textarea throat so plain HTTP relays and permission-stingy browsers still swallow every byte on click.
const copiedUntil = new Map()
function execCopy (text) {
  const prev = document.activeElement
  const ta = el('textarea')
  ta.value = text
  ta.readOnly = true
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none'
  document.body.append(ta)
  try { ta.focus({ preventScroll: true }) } catch { ta.focus() }
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  ta.remove()
  try { prev?.focus?.({ preventScroll: true }) } catch { prev?.focus?.() }
  return ok
}
function copyBtn (label, text) {
  const key = label + ':' + text
  const until = copiedUntil.get(key) || 0
  const rem = until - Date.now()
  const b = el('button', null, rem > 0 ? 'Copied!' : label)
  b.disabled = !text
  if (text) b.title = text
  if (rem > 0) setTimeout(() => { if (copiedUntil.get(key) === until) { copiedUntil.delete(key); b.textContent = label } }, rem)
  b.onclick = () => {
    if (!text) return
    const flash = () => {
      const exp = Date.now() + 1500
      copiedUntil.set(key, exp)
      b.textContent = 'Copied!'
      setTimeout(() => { if (copiedUntil.get(key) === exp) { copiedUntil.delete(key); b.textContent = label } }, 1500)
    }
    const ok = execCopy(text)
    if (ok) flash()
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => { if (!ok) flash() }, () => {})
    }
  }
  return b
}
// Hold the DOM still while Master's finger presses a button so SSE updates never yank the target mid-stroke before click lands.
let pressing = false, refreshQueued = false, player = null
addEventListener('pointerdown', () => { pressing = true })
for (const evName of ['pointerup', 'pointercancel', 'blur']) {
  addEventListener(evName, () => {
    if (!pressing) return
    pressing = false
    if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 0) }
  })
}

$('addForm').onsubmit = async ev => {
  ev.preventDefault()
  $('err').textContent = ''
  const val = $('uriInput').value.trim()
  const body = val.startsWith('peartube:') ? { uri: val } : { key: val, kind: $('kindSelect').value, alias: $('aliasInput').value.trim() }
  const ep = val.startsWith('peartube://watch/') || val.startsWith('peartube:watch/') ? '/v1/open' : '/v1/sources'
  const r = await fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
  if (r.error) $('err').textContent = r.error
  else { $('uriInput').value = ''; $('aliasInput').value = ''; refresh() }
}

async function refresh () {
  if (pressing || player) { refreshQueued = true; return }
  try {
    const [st, src, ent, jb, pl] = await Promise.all([
      fetch('/v1/status').then(r => r.json()),
      fetch('/v1/sources').then(r => r.json()),
      fetch('/v1/entries').then(r => r.json()),
      fetch('/v1/jobs').then(r => r.json()),
      fetch('/v1/plugins').then(r => r.json()).catch(() => ({ plugins: [] }))
    ])
    if (pressing || player) { refreshQueued = true; return }
    const rec = st.reciprocity || {}
    const sources = src.sources || []
    const trackerKey = sources.length ? (sources.find(s => s.primary && s.kind === 'tracker')?.key || sources.find(s => s.kind === 'tracker')?.key || '') : (st.tracker || '')
    const facts = [
      fact('peers', st.peers + (st.lanPeers ? ' (+' + st.lanPeers + ' LAN)' : '')),
      fact('stored', size(st.blobBytes)),
      fact('cached', size(st.cachedBytes || 0)),
      fact('P2P', '\\u2193 ' + size(st.downBps || 0) + '/s \\u00b7 \\u2191 ' + size(st.upBps || 0) + '/s'),
      el('span', 'badge ' + (rec.tier || ''), (rec.tier || 'peer') + ' (' + (rec.inflightMax || 128) + ' win)'),
      copyBtn('Copy Tracker URI', trackerKey ? 'peartube://tracker/' + trackerKey : ''),
      copyBtn('Copy My Channel URI', st.channel ? 'peartube://channel/' + st.channel : '')
    ]
    if ((st.cachedBytes || 0) > 0) {
      const clr = el('button', null, 'clear cache')
      clr.onclick = () => fetch('/v1/cache/clear', { method: 'POST', body: '{}' }).then(refresh)
      facts.push(clr)
    }
    $('facts').replaceChildren(...facts)
    const pubSet = new Set((src.published || []).map(p => p.key))
    $('sources').replaceChildren(...(src.sources || []).map(s => {
      const c = el('div', 'card row')
      const titleWrap = el('span', 'row')
      titleWrap.append(el('span', 'title', (s.alias || s.key.slice(0, 12) + '\\u2026') + ' (' + s.kind + (s.writable ? ', local' : '') + ')'))
      if (pubSet.has(s.key)) titleWrap.append(el('span', 'badge seeder', 'in directory'))
      c.append(titleWrap)
      const act = el('span', 'row')
      act.append(copyBtn('Copy URI', 'peartube://' + s.kind + '/' + s.key + (s.alias ? '?name=' + encodeURIComponent(s.alias) : '')))
      if (!s.primary) {
        if (pubSet.has(s.key)) {
          const unpub = el('button', null, 'Unlist')
          unpub.onclick = () => fetch('/v1/channel/sources/' + s.key, { method: 'DELETE' }).then(refresh)
          act.append(unpub)
        } else {
          const pub = el('button', null, 'List in Directory')
          pub.onclick = () => fetch('/v1/channel/publish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'source', sourceKey: s.key, kind: s.kind, title: s.alias || s.key.slice(0, 12), target: 'both' })
          }).then(refresh)
          act.append(pub)
        }
      }
      if (!s.primary && !s.writable) {
        const rm = el('button', null, 'Remove')
        rm.onclick = () => fetch('/v1/sources/' + s.key, { method: 'DELETE' }).then(refresh)
        act.append(rm)
      }
      c.append(act)
      return c
    }))
    const disc = src.discovered || []
    $('discoveredWrap').style.display = disc.length ? '' : 'none'
    $('discovered').replaceChildren(...disc.map(d => {
      const c = el('div', 'card row')
      const join = el('button', null, '+ Subscribe')
      join.onclick = () => fetch('/v1/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: d.key, kind: d.kind, alias: d.title }) }).then(refresh)
      c.append(el('span', 'title', d.title + ' (' + d.kind + ' \\u00b7 ' + d.key.slice(0, 10) + '\\u2026)'), join)
      return c
    }))
    const sortedEntries = (ent.results || []).slice().sort((a, b) => (Number(Boolean(b.local)) - Number(Boolean(a.local))) || ((b.cachedBytes || 0) - (a.cachedBytes || 0)))
    $('entries').replaceChildren(...(sortedEntries.length ? sortedEntries.map(e => {
      const c = el('div', 'card row')
      const info = el('div')
      const locTag = e.local ? 'local' : (e.cachedBytes ? 'cached ' + size(e.cachedBytes) : 'remote')
      info.append(el('div', 'title', e.title), el('div', 'meta', [e.id, size(e.size), locTag, e.sourceKind + ':' + e.source.slice(0, 8)].join(' \\u00b7 ')))
      const act = el('span', 'row')
      const play = el('button', 'primary', 'Stream')
      play.onclick = () => openPlayer(e)
      act.append(play, copyBtn('Copy Magnet', e.magnetUrl))
      c.append(info, act)
      return c
    }) : [el('div', 'empty', 'No entries synced yet.')]))
    const plugs = pl.plugins || []
    $('pluginsWrap').style.display = plugs.length ? '' : 'none'
    $('plugins').replaceChildren(...plugs.map(p => {
      const c = el('div', 'card row')
      const info = el('div')
      const summary = p.lastResult ? JSON.stringify(p.lastResult) : (p.description || '')
      info.append(el('div', 'title', p.name), el('div', 'meta', [p.runs ? p.runs + ' runs' : 'idle', summary].filter(Boolean).join(' \\u00b7 ')))
      if (p.lastError) info.append(el('div', 'error', p.lastError))
      const runBtn = el('button', null, 'Run Now')
      runBtn.onclick = () => fetch('/v1/plugins/' + encodeURIComponent(p.name) + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(refresh)
      c.append(info, runBtn)
      return c
    }))
    $('jobs').replaceChildren(...((jb.jobs || []).length ? jb.jobs.slice().sort((a, b) => b.created - a.created).map(j => {
      const c = el('div', 'card')
      const r = el('div', 'row'); r.append(el('div', 'title', j.title || j.id), el('span', 'badge ' + j.status, j.status))
      c.append(r, el('div', 'meta', [j.id, j.plugin || '', j.size ? size(j.size) : ''].filter(Boolean).join(' \\u00b7 ')))
      if (j.error && j.status !== 'done') c.append(el('div', 'error', j.error))
      return c
    }) : [el('div', 'empty', 'No acquisitions yet.')]))
  } catch (err) { $('err').textContent = 'Node unreachable: ' + err.message }
}
refresh()
const ev = new EventSource('/v1/events')
ev.onmessage = refresh
setInterval(refresh, 5000)

// In-browser peartube-media WebAssembly player: demuxes MKV/AVI/MP4/TS over same-origin HTTP Range,
// hardware-accelerates H.264/HEVC via fMP4 MSE when supported, falls back to WASM SIMD software video,
// and decodes surround AC-3/DTS/TrueHD/Opus/MP3 + SRT/ASS/PGS subtitles straight in the browser.
function fmtClock (s) {
  if (!Number.isFinite(s) || s < 0) s = 0
  const t = Math.floor(s)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = String(t % 60).padStart(2, '0')
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + r : m + ':' + r
}

function resolveStreamUrl (rawUrl) {
  try {
    const u = new URL(rawUrl, location.href)
    if (u.searchParams.has('key') && (u.searchParams.has('blob') || u.searchParams.has('pointer'))) {
      return location.origin + '/v1/blob' + u.search
    }
    return u.href
  } catch {
    return rawUrl
  }
}

// GPU BT.709 YUV420P WebGL renderer: uploads planar Y/U/V straight to textures in ~0.15ms with zero CPU color conversion.
let yuvGl = null
function getYuvGl () {
  if (yuvGl !== null) return yuvGl
  const c = $('pGlCanvas')
  const gl = c.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
  if (!gl) { yuvGl = false; return false }
  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, 'attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);gl_Position=vec4(a_pos,0.0,1.0);}')
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fs, 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_y;uniform sampler2D u_u;uniform sampler2D u_v;void main(){float y=(texture2D(u_y,v_uv).r-0.062745)*1.164384;float u=texture2D(u_u,v_uv).r-0.5;float v=texture2D(u_v,v_uv).r-0.5;gl_FragColor=vec4(y+1.792741*v,y-0.213249*u-0.532909*v,y+2.112402*u,1.0);}')
  gl.compileShader(fs)
  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog)
  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  const mkTex = unit => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  const texY = mkTex(0), texU = mkTex(1), texV = mkTex(2)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_y'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_u'), 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_v'), 2)
  yuvGl = { gl, canvas: c, texY, texU, texV, w: 0, h: 0 }
  return yuvGl
}

function audioOutTime (ctx) {
  if (!ctx) return 0
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null
  return (ts && ts.contextTime > 0) ? ts.contextTime : ctx.currentTime
}
// Keep one warm WASM Worker pre-compiled in the background so clicking Stream opens in 0 ms.
const ASSET_VER = '?v=4'
let sharedWorker = null
function getWorker () {
  if (!sharedWorker) {
    sharedWorker = new Worker('/web/player-worker.js' + ASSET_VER)
    sharedWorker.postMessage({ cmd: 'warmup', wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER })
  }
  return sharedWorker
}
setTimeout(() => { try { getWorker() } catch {} }, 150)

let openCounter = 0

function closePlayer () {
  if (!player) return
  const p = player
  player = null
  $('playerModal').classList.remove('open')
  cancelAnimationFrame(p.raf)
  try { p.worker?.postMessage({ cmd: 'close' }) } catch {}
  for (const s of p.audioNodes) { try { s.node.stop(); s.node.disconnect() } catch {} }
  try { p.audioCtx?.close() } catch {}
  const v = $('pVideo')
  v.pause()
  v.removeAttribute('src')
  v.load()
  if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} }
  $('pSubText').textContent = ''
  const sc = $('pSubCanvas')
  sc.getContext('2d').clearRect(0, 0, sc.width, sc.height)
  if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 50) }
}

function openPlayer (entry) {
  closePlayer()
  const streamUrl = resolveStreamUrl(entry.streamUrl)
  const worker = getWorker()
  $('pTitle').textContent = entry.title || entry.id
  $('pBadge').textContent = 'Opening…'
  $('pBadge').className = 'badge running'
  $('pRawLink').href = streamUrl
  $('pStatus').style.display = ''
  $('pStatus').textContent = 'Buffering stream…'
  $('pSubText').textContent = ''
  $('pPlayBtn').textContent = 'Pause'
  $('pSeek').value = '0'
  $('pClock').textContent = '0:00 / 0:00'
  $('playerModal').classList.add('open')

  const AudioCtx = window.AudioContext || window.webkitAudioContext
  const audioCtx = AudioCtx ? new AudioCtx() : null
  const gainNode = audioCtx ? audioCtx.createGain() : null
  if (gainNode) {
    gainNode.gain.value = ($('pMuteBtn').dataset.muted === '1') ? 0 : (Number($('pVol').value) / 100)
    gainNode.connect(audioCtx.destination)
  }
  audioCtx?.resume?.().catch(() => {})

  const seq = ++openCounter
  const p = {
    entry,
    streamUrl,
    worker,
    audioCtx,
    gainNode,
    pendingAudio: [],
    audioNodes: [],
    nextAudioCtxTime: 0,
    audioBaseMedia: 0,
    audioBaseCtx: 0,
    audioStarted: false,
    freeBaseMedia: 0,
    freeBasePerf: performance.now(),
    primed: false,
    paused: false,
    seeking: false,
    duration: 0,
    seq,
    manifest: null,
    videoStream: -1,
    audioStream: -1,
    subStream: -1,
    useMse: false,
    ms: null,
    msUrl: '',
    sb: null,
    mseQueue: [],
    mseReady: false,
    lastMseTime: 0,
    lastHardSync: 0,
    swFrames: [],
    lastSwPts: null,
    drawnFrames: 0,
    imgData: null,
    consumedVideoSec: 0,
    consumedAudioSec: 0,
    subCues: [],
    eof: false,
    raf: 0
  }
  player = p

  const canvas = $('pCanvas')
  const glCanvas = $('pGlCanvas')
  const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d')
  const subCanvas = $('pSubCanvas')
  const subCtx = subCanvas.getContext('2d')
  const video = $('pVideo')

  function currentMediaTime () {
    if (!p.primed || p.paused) return p.freeBaseMedia
    if (p.audioStream >= 0 && p.audioCtx && p.audioStarted && p.audioCtx.state === 'running') {
      const outT = audioOutTime(p.audioCtx)
      if (outT > p.audioBaseCtx + 0.01) {
        const t = p.audioBaseMedia + (outT - p.audioBaseCtx)
        p.freeBaseMedia = t
        p.freeBasePerf = performance.now()
        return t
      }
    }
    if (p.useMse && !video.paused && video.readyState >= 2) {
      p.freeBaseMedia = video.currentTime
      p.freeBasePerf = performance.now()
      return video.currentTime
    }
    return p.freeBaseMedia + Math.max(0, (performance.now() - p.freeBasePerf) / 1000)
  }

  function scheduleAudioChunk (m) {
    if (!p.audioCtx || !p.gainNode || m.samples <= 0) return
    const f32 = new Float32Array(m.buf)
    const ab = p.audioCtx.createBuffer(2, m.samples, m.rate)
    const ch0 = ab.getChannelData(0), ch1 = ab.getChannelData(1)
    for (let i = 0, j = 0; i < m.samples; i++, j += 2) {
      ch0[i] = f32[j]
      ch1[i] = f32[j + 1]
    }
    const node = p.audioCtx.createBufferSource()
    node.buffer = ab
    node.connect(p.gainNode)
    const nowCtx = p.audioCtx.currentTime
    const startCtx = Math.max(nowCtx + 0.02, p.nextAudioCtxTime || (nowCtx + 0.03))
    p.nextAudioCtxTime = startCtx + ab.duration
    if (!p.audioStarted) {
      p.audioStarted = true
      p.audioBaseMedia = m.pts
      p.audioBaseCtx = startCtx
    }
    const rec = { node, startCtx, endCtx: startCtx + ab.duration, pts: m.pts, dur: ab.duration }
    p.audioNodes.push(rec)
    node.onended = () => {
      const idx = p.audioNodes.indexOf(rec)
      if (idx !== -1) p.audioNodes.splice(idx, 1)
      if (player === p) p.consumedAudioSec += rec.dur
    }
    node.start(startCtx)
  }

  function tryPrime () {
    if (p.primed || !p.manifest) return
    const vReady = p.videoStream < 0 || (p.useMse ? (p.mseReady && video.readyState >= 2) : p.swFrames.length >= 2) || p.eof
    const aReady = p.audioStream < 0 || p.pendingAudio.length >= 1 || p.eof
    if (!vReady || !aReady) return
    p.primed = true
    $('pStatus').style.display = 'none'
    p.freeBasePerf = performance.now()
    while (p.pendingAudio.length > 0) scheduleAudioChunk(p.pendingAudio.shift())
    if (p.useMse && !p.paused) {
      p.lastMseTime = video.currentTime
      video.play().catch(() => {})
    }
  }

  video.onloadeddata = () => { if (player === p) tryPrime() }
  video.oncanplay = () => { if (player === p) tryPrime() }

  function resetMediaOutputs (targetSecs) {
    for (const s of p.audioNodes) { try { s.node.stop(); s.node.disconnect() } catch {} }
    p.audioNodes.length = 0
    p.pendingAudio.length = 0
    p.nextAudioCtxTime = 0
    p.audioStarted = false
    p.primed = false
    p.audioBaseMedia = targetSecs
    p.freeBaseMedia = targetSecs
    p.freeBasePerf = performance.now()
    p.swFrames.length = 0
    p.lastSwPts = null
    p.consumedVideoSec = 0
    p.consumedAudioSec = 0
    p.subCues.length = 0
    $('pSubText').textContent = ''
    subCtx.clearRect(0, 0, subCanvas.width, subCanvas.height)
    if (p.useMse) setupMse(targetSecs)
  }
  p.resetMediaOutputs = resetMediaOutputs

  function setupMse (startAt) {
    video.pause()
    video.playbackRate = 1
    if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} p.msUrl = '' }
    p.mseQueue.length = 0
    p.sb = null
    p.mseReady = false
    const MS = window.MediaSource || window.ManagedMediaSource
    if (!MS || !p.manifest?.mseCodec) { fallbackSw(startAt); return }
    const mime = 'video/mp4; codecs="' + p.manifest.mseCodec + '"'
    if (!MS.isTypeSupported(mime)) { fallbackSw(startAt); return }
    const ms = new MS()
    p.ms = ms
    p.msUrl = URL.createObjectURL(ms)
    video.style.display = 'block'
    canvas.style.display = 'none'
    glCanvas.style.display = 'none'
    video.src = p.msUrl
    ms.addEventListener('sourceopen', () => {
      if (player !== p || p.ms !== ms) return
      try {
        const sb = ms.addSourceBuffer(mime)
        sb.mode = 'segments'
        p.sb = sb
        sb.addEventListener('updateend', () => {
          if (player !== p || p.sb !== sb || p.ms?.readyState !== 'open') return
          if (!p.mseReady && sb.buffered.length > 0) {
            p.mseReady = true
            const bStart = sb.buffered.start(0)
            const bEnd = sb.buffered.end(0)
            const snap = Math.max(bStart, Math.min(startAt, bEnd > bStart + 0.05 ? bEnd - 0.05 : bStart))
            video.currentTime = snap
            p.lastMseTime = snap
            tryPrime()
          }
          drainMseQueue()
        })
        drainMseQueue()
      } catch {
        fallbackSw(currentMediaTime())
      }
    }, { once: true })
  }

  function drainMseQueue () {
    if (!p.sb || p.ms?.readyState !== 'open' || p.sb.updating) return
    if (p.mseQueue.length > 0) {
      const buf = p.mseQueue.shift()
      try { p.sb.appendBuffer(buf) } catch { fallbackSw(currentMediaTime()) }
      return
    }
    const now = currentMediaTime()
    if (p.sb.buffered.length > 0 && now - p.sb.buffered.start(0) > 20) {
      try { p.sb.remove(0, now - 12) } catch {}
    }
  }

  function fallbackSw (atSecs) {
    if (!p.useMse && (canvas.style.display === 'block' || glCanvas.style.display === 'block')) return
    p.useMse = false
    p.sb = null
    p.ms = null
    p.mseQueue.length = 0
    p.mseReady = false
    video.pause()
    video.removeAttribute('src')
    video.load()
    if (p.msUrl) { try { URL.revokeObjectURL(p.msUrl) } catch {} p.msUrl = '' }
    video.style.display = 'none'
    updateBadge()
    p.seq = ++openCounter
    resetMediaOutputs(atSecs)
    p.worker.postMessage({ cmd: 'seek', seq: p.seq, time: atSecs, videoStream: p.videoStream, audioStream: p.audioStream, subStream: p.subStream, useMse: false })
  }
  video.onerror = () => { if (player === p && p.useMse) fallbackSw(currentMediaTime()) }

  function updateBadge () {
    if (!p.manifest) return
    const vt = p.manifest.tracks.find(t => t.stream === p.videoStream)
    const at = p.manifest.tracks.find(t => t.stream === p.audioStream)
    const parts = [p.manifest.container]
    if (vt) parts.push(vt.codec + (p.useMse ? ' (MSE+WASM)' : ' (WASM)'))
    if (at) parts.push(at.codec)
    $('pBadge').textContent = parts.join(' \\u00b7 ')
    $('pBadge').className = 'badge seeder'
  }

  worker.onerror = err => {
    if (player !== p) return
    $('pStatus').style.display = ''
    $('pStatus').textContent = 'Worker error: ' + (err?.message || 'failed')
  }
  worker.onmessage = ev => {
    if (player !== p) return
    const m = ev.data || {}
    if (m.type === 'warm') return
    if (m.seq && m.seq !== p.seq) return
    if (m.type === 'error') {
      $('pStatus').style.display = ''
      $('pStatus').textContent = 'Playback error: ' + m.error
      $('pBadge').textContent = 'Error'
      $('pBadge').className = 'badge failed'
      return
    }
    if (m.type === 'manifest') {
      const mf = m.manifest
      p.manifest = mf
      p.duration = mf.duration || 0
      p.videoStream = mf.defaultVideo ?? -1
      p.audioStream = mf.defaultAudio ?? -1
      const subs = mf.tracks.filter(t => t.kind === 'subtitle')
      const auds = mf.tracks.filter(t => t.kind === 'audio')
      p.subStream = -1

      const aSel = $('pAudioSel')
      aSel.replaceChildren(...(auds.length ? auds.map((t, i) => {
        const o = el('option', null, 'Audio ' + (i + 1) + ': ' + [t.codec, t.language, t.channels ? t.channels + 'ch' : ''].filter(Boolean).join(' '))
        o.value = String(t.stream)
        if (t.stream === p.audioStream) o.selected = true
        return o
      }) : [Object.assign(el('option', null, 'No Audio'), { value: '-1' })]))
      aSel.disabled = auds.length <= 1

      const sSel = $('pSubSel')
      const offOpt = el('option', null, 'Subtitles: Off'); offOpt.value = '-1'
      sSel.replaceChildren(offOpt, ...subs.map((t, i) => {
        const o = el('option', null, 'Sub ' + (i + 1) + ': ' + [t.codec, t.language].filter(Boolean).join(' '))
        o.value = String(t.stream)
        return o
      }))
      sSel.disabled = subs.length === 0

      const MS = window.MediaSource || window.ManagedMediaSource
      p.useMse = Boolean(p.videoStream >= 0 && mf.mseCodec && MS && MS.isTypeSupported('video/mp4; codecs="' + mf.mseCodec + '"'))
      if (p.useMse) {
        setupMse(0)
      } else {
        video.style.display = 'none'
        glCanvas.style.display = 'none'
        canvas.style.display = 'none'
      }
      updateBadge()
      worker.postMessage({ cmd: 'start', seq: p.seq, videoStream: p.videoStream, audioStream: p.audioStream, subStream: p.subStream, useMse: p.useMse })
    } else if (m.type === 'mseInit' || m.type === 'mseSeg') {
      p.mseQueue.push(m.buf)
      drainMseQueue()
    } else if (m.type === 'videoFrame') {
      p.swFrames.push(m)
      if (p.drawnFrames === 0) drawSwFrame(m)
      tryPrime()
    } else if (m.type === 'audioChunk' && m.samples > 0) {
      if (!p.primed) {
        p.pendingAudio.push(m)
        tryPrime()
      } else {
        scheduleAudioChunk(m)
      }
    } else if (m.type === 'subText') {
      p.subCues.push({ kind: 'text', start: m.start, end: m.end, text: m.text })
    } else if (m.type === 'subBitmap') {
      p.subCues.push({ kind: 'bitmap', start: m.start, end: m.end, x: m.x, y: m.y, w: m.w, h: m.h, cw: m.cw, ch: m.ch, buf: m.buf })
    } else if (m.type === 'eof') {
      p.eof = true
      tryPrime()
    }
  }

  function drawSwFrame (f) {
    const r = f.yuv ? getYuvGl() : false
    if (r) {
      if (glCanvas.style.display !== 'block') { glCanvas.style.display = 'block'; canvas.style.display = 'none' }
      const { gl } = r
      const cw = (f.w + 1) >> 1, ch = (f.h + 1) >> 1
      const u8 = new Uint8Array(f.buf)
      const yLen = f.w * f.h, cLen = cw * ch
      const ySub = u8.subarray(0, yLen)
      const uSub = u8.subarray(yLen, yLen + cLen)
      const vSub = u8.subarray(yLen + cLen, yLen + cLen * 2)
      const resized = (r.w !== f.w || r.h !== f.h)
      if (resized) {
        r.w = f.w; r.h = f.h
        glCanvas.width = f.w; glCanvas.height = f.h
        gl.viewport(0, 0, f.w, f.h)
      }
      const up = (unit, tex, tw, th, data) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        if (resized) gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, tw, th, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data)
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, gl.LUMINANCE, gl.UNSIGNED_BYTE, data)
      }
      up(0, r.texY, f.w, f.h, ySub)
      up(1, r.texU, cw, ch, uSub)
      up(2, r.texV, cw, ch, vSub)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      p.drawnFrames++
      return
    }
    if (canvas.style.display !== 'block') { canvas.style.display = 'block'; glCanvas.style.display = 'none' }
    if (canvas.width !== f.w || canvas.height !== f.h || !p.imgData) {
      canvas.width = f.w
      canvas.height = f.h
      p.imgData = ctx2d.createImageData(f.w, f.h)
    }
    p.imgData.data.set(new Uint8ClampedArray(f.buf))
    ctx2d.putImageData(p.imgData, 0, 0)
    p.drawnFrames++
  }

  let lastCreditReport = performance.now()
  function tick () {
    if (player !== p) return
    p.raf = requestAnimationFrame(tick)
    if (!p.primed) tryPrime()
    const now = currentMediaTime()
    const pf = performance.now()

    if (p.primed && p.audioCtx && p.audioNodes.length > 0) {
      const ct = audioOutTime(p.audioCtx)
      for (const a of p.audioNodes) {
        if (ct >= a.startCtx && ct <= a.endCtx) {
          p.audioBaseMedia = a.pts + (ct - a.startCtx)
          p.audioBaseCtx = ct
          break
        }
      }
    }

    if (p.primed && p.useMse && p.mseReady && !p.paused) {
      const vt = video.currentTime
      if (vt > p.lastMseTime) {
        p.consumedVideoSec += Math.min(1.0, vt - p.lastMseTime)
        p.lastMseTime = vt
      }
      if (p.audioStarted && !video.seeking && video.readyState >= 2) {
        const drift = vt - now
        if (Math.abs(drift) > 1.2 && video.readyState >= 3 && (pf - p.lastHardSync) > 2500) {
          for (let i = 0; i < video.buffered.length; i++) {
            if (now >= video.buffered.start(i) && now + 0.25 <= video.buffered.end(i)) {
              p.lastHardSync = pf
              p.lastMseTime = now
              video.currentTime = now
              break
            }
          }
        } else if (drift > 0.20) video.playbackRate = 0.95
        else if (drift > 0.025) video.playbackRate = 0.98
        else if (drift < -0.20) video.playbackRate = 1.05
        else if (drift < -0.025) video.playbackRate = 1.02
        else if (video.playbackRate !== 1) video.playbackRate = 1
      }
    } else if (p.primed && !p.useMse && p.swFrames.length > 0 && !p.paused) {
      let pick = null
      while (p.swFrames.length > 0 && p.swFrames[0].pts <= now + 0.015) {
        const f = p.swFrames.shift()
        const step = p.lastSwPts !== null ? Math.max(0.01, Math.min(0.2, f.pts - p.lastSwPts)) : (1 / 30)
        p.lastSwPts = f.pts
        p.consumedVideoSec += step
        pick = f
      }
      if (pick) drawSwFrame(pick)
    }
    if (p.subCues.length > 0) {
      p.subCues = p.subCues.filter(c => c.end >= now - 2)
      const activeTexts = []
      let activeBmp = null
      for (const c of p.subCues) {
        if (now >= c.start && now <= c.end) {
          if (c.kind === 'text') activeTexts.push(c.text)
          else activeBmp = c
        }
      }
      const joined = activeTexts.join('\\n')
      if ($('pSubText').textContent !== joined) $('pSubText').textContent = joined
      if (activeBmp) {
        if (subCanvas.width !== activeBmp.cw || subCanvas.height !== activeBmp.ch) {
          subCanvas.width = activeBmp.cw
          subCanvas.height = activeBmp.ch
        }
        subCtx.clearRect(0, 0, subCanvas.width, subCanvas.height)
        if (activeBmp.w > 0 && activeBmp.h > 0) {
          subCtx.putImageData(new ImageData(new Uint8ClampedArray(activeBmp.buf), activeBmp.w, activeBmp.h), activeBmp.x, activeBmp.y)
        }
      } else {
        subCtx.clearRect(0, 0, subCanvas.width, subCanvas.height)
      }
    }

    if (!p.seeking && p.duration > 0) {
      $('pSeek').value = String(Math.min(1000, Math.round((now / p.duration) * 1000)))
    }
    $('pClock').textContent = fmtClock(now) + ' / ' + fmtClock(p.duration)

    if (p.primed && pf - lastCreditReport > 150 && (p.consumedVideoSec > 0 || p.consumedAudioSec > 0 || (pf - lastCreditReport > 500))) {
      const vSec = p.consumedVideoSec
      const aSec = p.consumedAudioSec
      p.consumedVideoSec = 0
      p.consumedAudioSec = 0
      lastCreditReport = pf
      worker.postMessage({ cmd: 'consumed', videoSec: vSec, audioSec: aSec, time: now })
    }
  }
  p.raf = requestAnimationFrame(tick)

  const extMatch = (entry.streamUrl || '').split('?')[0].split('.').pop() || ''
  worker.postMessage({ cmd: 'open', seq: p.seq, streamUrl, wasmUrl: location.origin + '/web/peartube_web.wasm' + ASSET_VER, ext: extMatch.length <= 5 ? extMatch : '' })
  return p
}

function togglePlay () {
  if (!player) return
  const now = player.freeBaseMedia
  player.paused = !player.paused
  player.freeBaseMedia = now
  player.freeBasePerf = performance.now()
  $('pPlayBtn').textContent = player.paused ? 'Play' : 'Pause'
  if (player.paused) {
    player.audioCtx?.suspend?.().catch(() => {})
    if (player.useMse) $('pVideo').pause()
  } else {
    if (player.audioCtx) {
      player.audioCtx.resume().then(() => {
        if (player) { player.audioBaseMedia = now; player.audioBaseCtx = player.audioCtx.currentTime }
      }).catch(() => {})
    }
    if (player.useMse && player.primed) $('pVideo').play().catch(() => {})
  }
}

function seekTo (targetSecs) {
  if (!player) return
  const clamped = Math.max(0, player.duration > 0 ? Math.min(player.duration, targetSecs) : targetSecs)
  player.seq = ++openCounter
  player.eof = false
  $('pStatus').style.display = ''
  $('pStatus').textContent = 'Seeking…'
  player.drawnFrames = 0
  player.resetMediaOutputs(clamped)
  player.worker.postMessage({
    cmd: 'seek',
    seq: player.seq,
    time: clamped,
    videoStream: player.videoStream,
    audioStream: player.audioStream,
    subStream: player.subStream,
    useMse: player.useMse
  })
}

$('pCloseBtn').onclick = closePlayer
$('pPlayBtn').onclick = togglePlay
$('pStage').onclick = togglePlay
$('pStage').ondblclick = () => $('pFsBtn').click()
$('pBackBtn').onclick = () => player && seekTo((player.freeBaseMedia || 0) - 10)
$('pFwdBtn').onclick = () => player && seekTo((player.freeBaseMedia || 0) + 10)
$('pFsBtn').onclick = () => {
  const m = $('playerModal')
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else m.requestFullscreen?.().catch(() => {})
}
$('pSeek').onpointerdown = () => { if (player) player.seeking = true }
$('pSeek').onchange = () => {
  if (!player) return
  player.seeking = false
  if (player.duration > 0) seekTo((Number($('pSeek').value) / 1000) * player.duration)
}
$('pAudioSel').onchange = () => {
  if (!player) return
  player.audioStream = Number($('pAudioSel').value)
  seekTo(player.freeBaseMedia || 0)
}
$('pSubSel').onchange = () => {
  if (!player) return
  player.subStream = Number($('pSubSel').value)
  seekTo(player.freeBaseMedia || 0)
}
$('pMuteBtn').onclick = () => {
  const muted = $('pMuteBtn').dataset.muted === '1' ? '0' : '1'
  $('pMuteBtn').dataset.muted = muted
  $('pMuteBtn').textContent = muted === '1' ? 'Unmute' : 'Mute'
  if (player?.gainNode) player.gainNode.gain.value = muted === '1' ? 0 : (Number($('pVol').value) / 100)
}
$('pVol').oninput = () => {
  $('pMuteBtn').dataset.muted = '0'
  $('pMuteBtn').textContent = 'Mute'
  if (player?.gainNode) player.gainNode.gain.value = Number($('pVol').value) / 100
}
addEventListener('keydown', ev => {
  if (!player) return
  if (ev.key === 'Escape') { ev.preventDefault(); closePlayer() }
  else if (ev.key === ' ') { ev.preventDefault(); togglePlay() }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); $('pBackBtn').click() }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); $('pFwdBtn').click() }
  else if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); $('pFsBtn').click() }
  else if (ev.key === 'm' || ev.key === 'M') { ev.preventDefault(); $('pMuteBtn').click() }
})
</script>
</body>
</html>
`
