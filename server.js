// Increase Node.js limits for header size before requiring anything
process.env.NODE_OPTIONS = '--max-http-header-size=32768'

const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '127.0.0.1'
const port = process.env.PORT || 3000

// Create the Next.js app
const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  // Create HTTP server with increased header size limits
  const server = createServer({
    maxHeaderSize: 32768, // 32KB instead of default 8KB
  }, async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true)
      await handle(req, res, parsedUrl)
    } catch (err) {
      console.error('Error occurred handling', req.url, err)
      res.statusCode = 500
      res.end('internal server error')
    }
  })

  // Set server timeout for long-running requests. The cleaning optimizer
  // (POST /api/soiling/.../optimize) legitimately runs 30-60s.
  server.timeout = 120000 // 120 seconds

  server
    .once('error', (err) => {
      console.error('Server error:', err)
      process.exit(1)
    })
    .listen(port, hostname, () => {
      console.log(`> Ready on http://${hostname}:${port}`)
    })
})