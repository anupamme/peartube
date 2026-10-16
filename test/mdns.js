// mDNS in memory, for LAN discovery tests. Every browse hears every
// advertisement, at 127.0.0.1, through that side's view(service), which can
// change what it sees.
export function mdnsBus () {
  const records = new Set()
  const browsers = new Set()
  return (view = service => service) => ({
    advertise (record) {
      records.add(record)
      for (const b of browsers) b.hear(record)
      return { stop: async () => records.delete(record) }
    },
    browse (query, handlers) {
      const b = { hear: record => handlers.onService(view({ ...record, addresses: ['127.0.0.1'] })) }
      browsers.add(b)
      for (const record of records) b.hear(record)
      return { stop: async () => browsers.delete(b) }
    }
  })
}
