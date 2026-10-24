import { createServer } from 'node:http'
import b4a from 'b4a'
import { page } from './ui.js'

const MAX_BODY = 64 * 1024

// The relay's one HTTP port: the UI at / and the /v1 machine API. No auth for
// now, so bind it to a trusted network only.
export function createApi (state) {
  async function body (req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 })
      chunks.push(chunk)
    }
    try { return JSON.parse(b4a.toString(b4a.concat(chunks))) } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }) }
  }

  async function route (req, url) {
    const { node, acquirer } = state
    const path = url.pathname
    if (req.method === 'GET' && path === '/v1/status') return node ? node.status() : state.fallbackStatus
    if (req.method === 'GET' && path === '/v1/search') {
      const id = url.searchParams.get('id')
      if (!id) throw Object.assign(new Error('id is required'), { status: 400 })
      return { results: node ? await node.search(id) : [] }
    }
    if (req.method === 'GET' && path === '/v1/entries') return { results: node ? await node.search() : [] }
    if (req.method === 'POST' && path === '/v1/cache/clear') {
      if (!node) throw Object.assign(new Error('Node still starting'), { status: 503 })
      const { key = null } = await body(req).catch(() => ({}))
      return node.clearCache(key)
    }
    if (req.method === 'POST' && path === '/v1/acquire') {
      if (!acquirer) throw Object.assign(new Error('Node still starting'), { status: 503 })
      const { id, title, source } = await body(req)
      return acquirer.add({ id, title, source })
    }
    if (req.method === 'GET' && path === '/v1/jobs') return { jobs: acquirer ? acquirer.list() : state.fallbackJobs() }
    const match = path.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/)
    if (match && req.method === 'GET') return acquirer ? acquirer.get(match[1]) : state.fallbackJobs().find(j => j.jobId === match[1]) || null
    if (match && req.method === 'DELETE') return acquirer ? acquirer.cancel(match[1]) : null
    return undefined
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    let status = 200
    let payload
    try {
      payload = await route(req, url)
      if (payload === undefined || payload === null) { status = 404; payload = { error: 'not found' } }
    } catch (err) {
      status = err.status || 400
      payload = { error: err.message }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
}
