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
  button:hover:not(:disabled), a.btn:hover { background: #323947; }
  button:disabled { opacity: .45; cursor: default; }
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
let pressing = false, refreshQueued = false
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
  if (pressing) { refreshQueued = true; return }
  try {
    const [st, src, ent, jb, pl] = await Promise.all([
      fetch('/v1/status').then(r => r.json()),
      fetch('/v1/sources').then(r => r.json()),
      fetch('/v1/entries').then(r => r.json()),
      fetch('/v1/jobs').then(r => r.json()),
      fetch('/v1/plugins').then(r => r.json()).catch(() => ({ plugins: [] }))
    ])
    if (pressing) { refreshQueued = true; return }
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
    $('entries').replaceChildren(...((ent.results || []).length ? ent.results.map(e => {
      const c = el('div', 'card row')
      const info = el('div')
      info.append(el('div', 'title', e.title), el('div', 'meta', [e.id, size(e.size), e.sourceKind + ':' + e.source.slice(0, 8)].join(' \\u00b7 ')))
      const act = el('span', 'row')
      const play = el('a', 'btn', 'Stream'); play.href = e.streamUrl; play.target = '_blank'
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
</script>
</body>
</html>
`
