// Run both graph traversals under Bare: their lexer segfaults on Node 22.
// bare-process supplies the process global expected by the upstream CLIs.
require('bare-process/global')

if (process.argv[2] === '--link') {
  const [host, out, importsPath, entry] = process.argv.slice(3)
  const link = require('bare-link')
  const imports = require(importsPath)

  async function main() {
    for await (const resource of link(entry, { hosts: [host], imports, out })) {
      console.log(`Linked ${resource}`)
    }
  }

  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
} else {
  require('../node_modules/bare-pack/bin.js')
}
