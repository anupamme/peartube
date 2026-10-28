import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import b4a from 'b4a'

// Tells what a link holds before it is acquired: a direct media file (named by its filename) or a
// web page that yt-dlp can read (YouTube, Vimeo, ...). Movie and episode names get Cinemeta
// suggestions; an accepted one becomes the entry's `imdb:tt…` id, the id MediaStorm searches by.
const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|avi|mov|ts|m2ts|mts|mpg|mpeg|wmv|flv|ogv|3gp)$/i
const NOISE = /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvdrip|remux|proper|repack|extended|unrated|x26[45]|h\.?26[45]|hevc|avc|av1|xvid|divx|aac|ac3|e?ac-?3|ddp?|dts|truehd|atmos|flac|opus|mp3)\b/i

export function parseName (raw) {
  let name = String(raw || '')
  try { name = decodeURIComponent(new URL(name).pathname.split('/').pop() || name) } catch {}
  const ext = (name.match(MEDIA_EXT) || [])[1]?.toLowerCase() || ''
  // A second media extension (`.mkv.mp4`) is part of the release name, not the title.
  const stem = name.replace(MEDIA_EXT, '').replace(MEDIA_EXT, '')
  const words = stem.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  const ep = words.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i) || words.match(/\b(\d{1,2})x(\d{2,3})\b/)
  const year = [...words.matchAll(/[([]?\b(19[2-9]\d|20[0-4]\d)\b[)\]]?/g)].pop()
  // A year or episode marks where the title ends; release tags only when neither is there ("Charlotte's Web 2006").
  const marks = [ep?.index, year?.index].filter(i => i != null && i > 0)
  const cuts = marks.length ? marks : [words.search(NOISE)].filter(i => i > 0)
  const pick = re => (words.match(re) || [])[1] || ''
  const title = words.slice(0, cuts.length ? Math.min(...cuts) : words.length).replace(/[[(-]+\s*$/, '').trim() || words
  return {
    title,
    year: year ? Number(year[1]) : null,
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
    resolution: pick(/\b(2160p|1080p|720p|576p|480p|4k)\b/i).toLowerCase(),
    codec: pick(/\b(x26[45]|h\.?26[45]|hevc|avc|av1|vp9|xvid|divx)\b/i).toLowerCase(),
    audio: pick(/\b(e?ac-?3|ddp?5\.1|ddp?|dts(?:-hd)?|truehd|atmos|aac|flac|opus|mp3)\b/i).toLowerCase(),
    ext
  }
}

function send (url, { method = 'GET', headers = {}, timeoutMs = 10_000, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { return reject(new Error('Not a valid link')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Only http(s) links can be added'))
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method, headers: { 'user-agent': 'PearTube', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume()
        resolve(send(new URL(res.headers.location, u).href, { method, headers, timeoutMs, redirects: redirects + 1 }))
        return
      }
      const chunks = []
      res.on('data', c => { if (method !== 'HEAD') chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, url: u.href, body: b4a.toString(b4a.concat(chunks), 'utf8') }))
      res.on('error', reject)
    })
    req.setTimeout?.(timeoutMs, () => req.destroy(new Error('Timed out')))
    req.on('error', reject)
    req.end()
  })
}

function ytdlp (url, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    let child
    // One progressive HTTP file with audio and video: the acquirer stores a single stream.
    const args = ['-J', '--no-playlist', '--no-warnings', '-f', 'b[vcodec!=none][acodec!=none][protocol^=http]/b[protocol^=http]', url]
    try { child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return reject(missing()) }
    const out = []
    const err = []
    let exited = null
    let ended = false
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    const finish = () => {
      if (exited === null || !ended) return
      clearTimeout(timer)
      if (exited !== 0) {
        const msg = b4a.toString(b4a.concat(err), 'utf8').split('\n').find(l => l.startsWith('ERROR:')) || 'This page has no video yt-dlp can read'
        return reject(new Error(msg.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 200)))
      }
      try { resolve(JSON.parse(b4a.toString(b4a.concat(out), 'utf8'))) } catch { reject(new Error('yt-dlp returned no metadata')) }
    }
    child.on('error', () => { clearTimeout(timer); reject(missing()) })
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.stdout.on('end', () => { ended = true; finish() })
    child.on('exit', code => { exited = code ?? 1; finish() })
  })
}

function missing () {
  return Object.assign(new Error('Install yt-dlp to add page links'), { status: 501, code: 'YTDLP_MISSING' })
}

// The file a page link plays, resolved again on every attempt: page media URLs expire.
export async function resolvePage (pageUrl) {
  const info = await ytdlp(pageUrl)
  if (!info.url) throw new Error('This page has no single-file video')
  return { url: info.url, headers: info.http_headers || {} }
}

async function probe (url) {
  let head = null
  try { head = await send(url, { method: 'HEAD' }) } catch {}
  const type = String(head?.headers['content-type'] || '').toLowerCase()
  const finalUrl = head?.url || url
  const looksMedia = type.startsWith('video/') || type.includes('matroska') || (MEDIA_EXT.test(new URL(finalUrl).pathname) && !type.startsWith('text/'))
  if (head && head.status < 400 && looksMedia) {
    return { kind: 'file', name: decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || ''), size: Number(head.headers['content-length']) || null, contentType: type || null }
  }
  if (head && head.status >= 400 && MEDIA_EXT.test(new URL(url).pathname)) throw new Error(`The link answered ${head.status}`)
  const info = await ytdlp(url)
  return {
    kind: 'page',
    name: info.title || '',
    site: info.extractor_key || info.extractor || '',
    uploader: info.uploader || info.channel || '',
    duration: Number(info.duration) || null,
    thumbnail: info.thumbnail || null,
    size: Number(info.filesize || info.filesize_approx) || null,
    resolution: info.height ? info.height + 'p' : '',
    pageId: String(info.webpage_url || url)
  }
}

export async function cinemetaSearch (base, { title, year, season }) {
  if (!base || !title) return []
  const type = season ? 'series' : 'movie'
  const res = await send(`${base}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`, { timeoutMs: 8000 })
  if (res.status !== 200) return []
  let metas = []
  try { metas = JSON.parse(res.body).metas || [] } catch {}
  const out = []
  for (const m of metas) {
    const imdb = String(m.imdb_id || m.id || '')
    if (!/^tt\d{5,10}$/.test(imdb)) continue
    const y = Number(String(m.releaseInfo || m.year || '').slice(0, 4)) || null
    out.push({ imdb, type, name: String(m.name || ''), year: y, poster: typeof m.poster === 'string' ? m.poster : null })
  }
  // Only names sharing at least half their words with the parsed title; exact title first, then same year,
  // then Cinemeta's own order (a stable sort keeps it).
  const want = norm(title)
  const words = new Set(want.split(' '))
  const related = c => {
    const theirs = norm(c.name).split(' ')
    return theirs.filter(w => words.has(w)).length / Math.max(theirs.length, words.size) >= 0.5
  }
  const score = c => (norm(c.name) === want ? 2 : 0) + (year && c.year === year ? 1 : 0)
  return out.filter(related).sort((a, b) => score(b) - score(a)).slice(0, 6)
}

const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').replace(/^(the|a|an) /, '').trim()

// A suggestion is taken without asking only when the title matches exactly and the year (if known) agrees.
const strong = (c, parsed) => norm(c.name) === norm(parsed.title) && (c.type === 'series' || !parsed.year || c.year === parsed.year)

// The id and title an entry is announced under for a chosen candidate, in the shapes MediaStorm searches for.
export function candidateEntry (c, parsed) {
  if (c.type === 'series' && parsed.season != null && parsed.episode != null) {
    const se = `s${String(parsed.season).padStart(2, '0')}e${String(parsed.episode).padStart(2, '0')}`
    return { id: `imdb:${c.imdb}:${se}`, title: `${c.name} ${se.toUpperCase()}` }
  }
  return { id: `imdb:${c.imdb}`, title: c.year ? `${c.name} ${c.year}` : c.name }
}

export async function identify (url, { cinemetaUrl = '' } = {}) {
  const link = await probe(url)
  const parsed = parseName(link.name)
  if (link.resolution) parsed.resolution = link.resolution
  // Page titles are free text; only ones that read like a release (a year or an episode) get movie suggestions.
  const lookup = link.kind === 'file' || parsed.year || parsed.season != null
  const candidates = lookup ? await cinemetaSearch(cinemetaUrl, parsed).catch(() => []) : []
  const se = parsed.season != null ? ` S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}` : ''
  const plain = {
    id: 'clip:' + createHash('sha256').update(link.kind === 'page' ? link.pageId : url).digest('hex').slice(0, 16),
    title: (link.kind === 'page' ? link.name : parsed.title + se) || parsed.title
  }
  const { pageId: _p, ...shown } = link
  const list = candidates.map(c => ({ ...c, ...candidateEntry(c, parsed) }))
  return {
    link: shown,
    parsed,
    candidates: list,
    match: list.find(c => strong(c, parsed))?.id || null,
    plain
  }
}

const posterCache = new Map()
export async function posterUrl (base, imdb) {
  if (!base || !/^tt\d{5,10}$/.test(imdb)) return null
  if (posterCache.has(imdb)) return posterCache.get(imdb)
  let poster = null
  for (const type of ['movie', 'series']) {
    const res = await send(`${base}/meta/${type}/${imdb}.json`, { timeoutMs: 8000 }).catch(() => null)
    try { poster = res?.status === 200 ? JSON.parse(res.body).meta?.poster || null : null } catch {}
    if (poster) break
  }
  if (posterCache.size > 2000) posterCache.clear()
  posterCache.set(imdb, poster)
  return poster
}
