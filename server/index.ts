import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import sirv from 'sirv'
import { createServerLibraryMiddleware } from './library/middleware.ts'

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
	console.error(`[server] Invalid PORT value: ${process.env.PORT}`)
	process.exit(1)
}

const buildDir = resolve(import.meta.dirname, '../build')

if (!existsSync(buildDir)) {
	console.error('[server] Build output not found. Run `pnpm run build` first.')
	process.exit(1)
}

// SPA fallback page produced by adapter-static (PUBLIC_FALLBACK_PAGE at build time)
const fallbackPage = ['200.html', 'index.html'].find((page) => existsSync(resolve(buildDir, page)))

const serveStatic = sirv(buildDir, {
	etag: true,
	...(fallbackPage === undefined ? {} : { single: fallbackPage }),
})

const serverLibraryMiddleware = createServerLibraryMiddleware()

const handleRequest = (req: IncomingMessage, res: ServerResponse, error?: unknown): void => {
	if (error !== undefined && error !== null) {
		console.error('[server] Middleware error:', error)
		res.writeHead(500).end()
		return
	}

	const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
	if (pathname === '/api' || pathname.startsWith('/api/')) {
		// Unknown API routes must not fall through to the SPA fallback
		res.writeHead(404, {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		})
		res.end(JSON.stringify({ error: { code: 'FILE_NOT_FOUND', message: 'Not found' } }))
		return
	}

	serveStatic(req, res, () => {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('Not found')
	})
}

const server = createServer((req, res) => {
	void serverLibraryMiddleware(req, res, (error?: unknown) => {
		handleRequest(req, res, error)
	}).catch((error: unknown) => {
		handleRequest(req, res, error)
	})
})

server.listen(port, host, () => {
	console.info(`[server] Snae Player listening on http://${host}:${port}`)
	console.info(
		process.env.MUSIC_DIR
			? '[server] Server library enabled (MUSIC_DIR is set)'
			: '[server] Server library disabled (MUSIC_DIR is not set)',
	)
})
