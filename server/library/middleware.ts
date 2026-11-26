import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, sep } from 'node:path'
import {
	getAudioMimeType,
	SERVER_LIBRARY_BASE_PATH,
	type ServerLibraryErrorCode,
	type ServerLibraryRescanResponse,
} from '../../src/lib/server-library/api.ts'
import { createLibraryIndexStore, type LibraryIndexStore } from './index-store.ts'
import { createLibraryScanner, type LibraryScanner } from './scanner.ts'
import { collectAudioFiles, isErrorCode, resolveMusicDir } from './walk.ts'

type NextFunction = (error?: unknown) => void

const STATUS_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/status`
const FILES_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/files`
const FILE_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/file`
const CATALOG_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/catalog`
const RESCAN_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/rescan`
const ARTWORK_ROUTE_PREFIX = `${SERVER_LIBRARY_BASE_PATH}/artwork/`

const ARTWORK_HASH_RE = /^[0-9a-f]{64}$/

const sendJson = (
	res: ServerResponse,
	statusCode: number,
	body: unknown,
	headOnly: boolean,
): void => {
	const payload = JSON.stringify(body)
	res.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Length': Buffer.byteLength(payload),
	})
	res.end(headOnly ? undefined : payload)
}

const sendError = (
	res: ServerResponse,
	statusCode: number,
	code: ServerLibraryErrorCode,
	message: string,
	headOnly: boolean,
): void => {
	sendJson(res, statusCode, { error: { code, message } }, headOnly)
}

/**
 * Validates the `path` query parameter and resolves it inside the real music directory.
 * Returns the absolute file path, or `undefined` when the path is invalid or escapes the directory.
 */
const resolveRequestedFile = (
	rawPath: string | null,
	realMusicDir: string,
): { resolvedPath: string } | { invalid: true } | undefined => {
	if (rawPath === null || rawPath === '') {
		return { invalid: true }
	}

	if (rawPath.includes('\0') || rawPath.includes('\\') || rawPath.startsWith('/')) {
		return { invalid: true }
	}

	const segments = rawPath.split('/')
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') {
			return { invalid: true }
		}
	}

	const firstSegment = segments[0]
	if (firstSegment !== undefined && WINDOWS_DRIVE_PATH_RE.test(firstSegment)) {
		return { invalid: true }
	}

	const resolvedPath = resolve(realMusicDir, ...segments)
	if (resolvedPath !== realMusicDir && !resolvedPath.startsWith(realMusicDir + sep)) {
		return { invalid: true }
	}

	return { resolvedPath }
}

interface ByteRange {
	start: number
	end: number
}

const RANGE_HEADER_RE = /^bytes=(\d*)-(\d*)$/
const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:/

/** Parses a single-range `Range` header. Returns `null` when the header is absent, `'invalid'` when unusable. */
const parseRangeHeader = (
	header: string | undefined,
	size: number,
): ByteRange | 'invalid' | null => {
	if (header === undefined) {
		return null
	}

	const match = RANGE_HEADER_RE.exec(header.trim())
	const startRaw = match?.[1]
	const endRaw = match?.[2]
	if (match === null || startRaw === undefined || endRaw === undefined) {
		return 'invalid'
	}

	if (startRaw === '' && endRaw === '') {
		return 'invalid'
	}

	if (startRaw === '') {
		// Suffix range: the last N bytes
		const suffixLength = Number.parseInt(endRaw, 10)
		if (suffixLength === 0 || size === 0) {
			return 'invalid'
		}
		return { start: Math.max(0, size - suffixLength), end: size - 1 }
	}

	const start = Number.parseInt(startRaw, 10)
	const end = endRaw === '' ? size - 1 : Math.min(Number.parseInt(endRaw, 10), size - 1)
	if (start >= size || start > end) {
		return 'invalid'
	}

	return { start, end }
}

const handleStatus = async (
	res: ServerResponse,
	headOnly: boolean,
	musicDir: string | undefined,
	scanner: LibraryScanner,
): Promise<void> => {
	if (musicDir === undefined) {
		sendJson(res, 200, { enabled: false }, headOnly)
		return
	}

	const realDir = await resolveMusicDir(musicDir)
	if (realDir === undefined) {
		sendError(res, 503, 'DIRECTORY_UNAVAILABLE', 'Music directory is unavailable', headOnly)
		return
	}

	scanner.ensureStarted()
	const status = scanner.getStatus()
	sendJson(
		res,
		200,
		{
			enabled: true,
			state: status.state,
			current: status.current,
			total: status.total,
			...(status.error === undefined ? {} : { error: status.error }),
		},
		headOnly,
	)
}

const handleFiles = async (
	res: ServerResponse,
	headOnly: boolean,
	musicDir: string | undefined,
): Promise<void> => {
	if (musicDir === undefined) {
		sendError(res, 404, 'SERVER_LIBRARY_DISABLED', 'Server library is disabled', headOnly)
		return
	}

	const realDir = await resolveMusicDir(musicDir)
	if (realDir === undefined) {
		sendError(res, 503, 'DIRECTORY_UNAVAILABLE', 'Music directory is unavailable', headOnly)
		return
	}

	try {
		const files = await collectAudioFiles(realDir)
		sendJson(res, 200, { files }, headOnly)
	} catch (error) {
		console.error('[server-library] Failed to list music directory:', error)
		sendError(
			res,
			503,
			'DIRECTORY_UNAVAILABLE',
			'Music directory could not be listed',
			headOnly,
		)
	}
}

const sendFileContent = (
	req: IncomingMessage,
	res: ServerResponse,
	resolvedPath: string,
	size: number,
	mimeType: string,
): void => {
	const range = parseRangeHeader(req.headers.range, size)
	if (range === 'invalid') {
		res.writeHead(416, {
			'Content-Range': `bytes */${size}`,
			'Cache-Control': 'no-store',
		})
		res.end()
		return
	}

	const headers: Record<string, string | number> = {
		'Content-Type': mimeType,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'no-store',
	}

	let streamOptions: { start: number; end: number } | undefined
	if (range === null) {
		headers['Content-Length'] = size
	} else {
		headers['Content-Length'] = range.end - range.start + 1
		headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
		streamOptions = range
	}

	res.writeHead(range === null ? 200 : 206, headers)
	if (req.method === 'HEAD') {
		res.end()
		return
	}

	const stream = createReadStream(resolvedPath, streamOptions)
	stream.on('error', (error) => {
		console.error('[server-library] Failed to stream file:', error)
		res.destroy(error)
	})
	stream.pipe(res)
}

const handleFile = async (
	req: IncomingMessage,
	res: ServerResponse,
	headOnly: boolean,
	musicDir: string | undefined,
	requestUrl: URL,
): Promise<void> => {
	if (musicDir === undefined) {
		sendError(res, 404, 'SERVER_LIBRARY_DISABLED', 'Server library is disabled', headOnly)
		return
	}

	const rawPath = requestUrl.searchParams.get('path')

	const realDir = await resolveMusicDir(musicDir)
	if (realDir === undefined) {
		sendError(res, 503, 'DIRECTORY_UNAVAILABLE', 'Music directory is unavailable', headOnly)
		return
	}

	const requested = resolveRequestedFile(rawPath, realDir)
	if (requested === undefined || 'invalid' in requested) {
		sendError(res, 400, 'INVALID_PATH', 'Invalid file path', headOnly)
		return
	}

	const mimeType = getAudioMimeType(rawPath ?? '')
	if (mimeType === undefined) {
		sendError(res, 404, 'FILE_NOT_FOUND', 'File not found', headOnly)
		return
	}

	try {
		const fileLstat = await lstat(requested.resolvedPath)
		if (fileLstat.isSymbolicLink() || !fileLstat.isFile()) {
			sendError(res, 404, 'FILE_NOT_FOUND', 'File not found', headOnly)
			return
		}

		// Guard against symlinks in intermediate directories escaping the music directory
		const realFilePath = await realpath(requested.resolvedPath)
		if (realFilePath !== realDir && !realFilePath.startsWith(realDir + sep)) {
			sendError(res, 404, 'FILE_NOT_FOUND', 'File not found', headOnly)
			return
		}

		sendFileContent(req, res, requested.resolvedPath, fileLstat.size, mimeType)
	} catch (error) {
		if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTDIR')) {
			sendError(res, 404, 'FILE_NOT_FOUND', 'File not found', headOnly)
			return
		}
		throw error
	}
}

/** Serves the catalog of the last completed index only (CONTRACTS.md §10). */
const handleCatalog = (
	res: ServerResponse,
	headOnly: boolean,
	musicDir: string | undefined,
	scanner: LibraryScanner,
	getStore: () => LibraryIndexStore,
): void => {
	if (musicDir === undefined) {
		sendError(res, 404, 'SERVER_LIBRARY_DISABLED', 'Server library is disabled', headOnly)
		return
	}

	scanner.ensureStarted()
	const store = getStore()
	if (!store.hasCompleteIndex()) {
		sendError(res, 409, 'SCAN_IN_PROGRESS', 'Catalog is not ready yet', headOnly)
		return
	}

	sendJson(res, 200, { revision: store.getRevision(), tracks: store.getCatalog() }, headOnly)
}

/** Idempotently starts a background rescan; a scan already in flight is left alone. */
const handleRescan = async (
	res: ServerResponse,
	musicDir: string | undefined,
	scanner: LibraryScanner,
): Promise<void> => {
	if (musicDir === undefined) {
		sendError(res, 404, 'SERVER_LIBRARY_DISABLED', 'Server library is disabled', false)
		return
	}

	const realDir = await resolveMusicDir(musicDir)
	if (realDir === undefined) {
		sendError(res, 503, 'DIRECTORY_UNAVAILABLE', 'Music directory is unavailable', false)
		return
	}

	scanner.startScan()
	const body: ServerLibraryRescanResponse = { state: 'scanning' }
	sendJson(res, 202, body, false)
}

const handleArtwork = (
	res: ServerResponse,
	headOnly: boolean,
	musicDir: string | undefined,
	hash: string,
	getStore: () => LibraryIndexStore,
): void => {
	if (musicDir === undefined) {
		sendError(res, 404, 'SERVER_LIBRARY_DISABLED', 'Server library is disabled', headOnly)
		return
	}

	if (!ARTWORK_HASH_RE.test(hash)) {
		sendError(res, 404, 'ARTWORK_NOT_FOUND', 'Artwork not found', headOnly)
		return
	}

	const artwork = getStore().getArtwork(hash)
	if (artwork === undefined) {
		sendError(res, 404, 'ARTWORK_NOT_FOUND', 'Artwork not found', headOnly)
		return
	}

	res.writeHead(200, {
		'Content-Type': artwork.mimeType,
		'Content-Length': artwork.bytes.byteLength,
		// Content-addressed bytes are immutable by construction
		'Cache-Control': 'public, max-age=31536000, immutable',
	})
	res.end(headOnly ? undefined : Buffer.from(artwork.bytes))
}

const DEFAULT_SCAN_CONCURRENCY = 4
const MIN_SCAN_CONCURRENCY = 1
const MAX_SCAN_CONCURRENCY = 16

const normalizeScanConcurrency = (value: number | string | undefined): number => {
	const parsed = typeof value === 'string' ? Number(value) : value
	if (parsed === undefined || !Number.isInteger(parsed)) {
		return DEFAULT_SCAN_CONCURRENCY
	}
	return Math.min(MAX_SCAN_CONCURRENCY, Math.max(MIN_SCAN_CONCURRENCY, parsed))
}

/** @public */
export interface ServerLibraryMiddlewareOptions {
	/**
	 * Directory holding `library.sqlite`. Defaults to `DATA_DIR` env or `./.data`,
	 * resolved once when the middleware is created.
	 */
	dataDir?: string
	/** Max concurrent metadata parses. Defaults to `SNAE_SCAN_CONCURRENCY` env or 4, clamped to 1–16. */
	scanConcurrency?: number
}

/** Connect-style middleware with a test seam to await background scans. */
/** @public */
export interface ServerLibraryMiddleware {
	(req: IncomingMessage, res: ServerResponse, next: NextFunction): Promise<void>
	/** Resolves once no index scan is running. */
	waitForScanIdle: () => Promise<void>
}

/**
 * Connect-style middleware serving the read-only server music library API and the
 * persistent server-side music index (CONTRACTS.md §4, §10).
 * Handles only URLs under `/api/server-library`; everything else is passed to `next()`.
 *
 * By default `getMusicDir` reads `process.env.MUSIC_DIR` on every request, so an empty
 * or missing value disables the library (but not the player) without a restart.
 * When the library is enabled, a background index scan starts on creation (and lazily
 * on the first request if `MUSIC_DIR` appears later); authentication is a separate
 * middleware concern and is not checked here.
 * @public
 */
export const createServerLibraryMiddleware = (
	getMusicDir: () => string | undefined = () => process.env.MUSIC_DIR || undefined,
	options?: ServerLibraryMiddlewareOptions,
): ServerLibraryMiddleware => {
	const dataDir = options?.dataDir ?? (process.env.DATA_DIR || './.data')
	const concurrency = normalizeScanConcurrency(
		options?.scanConcurrency ?? process.env.SNAE_SCAN_CONCURRENCY,
	)

	let store: LibraryIndexStore | undefined
	const getStore = (): LibraryIndexStore => {
		store ??= createLibraryIndexStore(dataDir)
		return store
	}

	const scanner = createLibraryScanner({ getMusicDir, getStore, concurrency })

	// Startup background scan (CONTRACTS.md §10). Failures move the scanner to the
	// error state and are retried through POST /rescan, never in a request loop.
	if (getMusicDir() !== undefined) {
		scanner.startScan()
	}

	const middleware = async (
		req: IncomingMessage,
		res: ServerResponse,
		next: NextFunction,
	): Promise<void> => {
		const requestUrl = new URL(req.url ?? '/', 'http://localhost')
		const pathname = requestUrl.pathname

		if (
			pathname !== SERVER_LIBRARY_BASE_PATH &&
			!pathname.startsWith(`${SERVER_LIBRARY_BASE_PATH}/`)
		) {
			next()
			return
		}

		const headOnly = req.method === 'HEAD'
		try {
			if (pathname === RESCAN_ROUTE) {
				if (req.method !== 'POST') {
					res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' })
					res.end()
					return
				}
				await handleRescan(res, getMusicDir(), scanner)
				return
			}

			if (req.method !== 'GET' && !headOnly) {
				res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' })
				res.end()
				return
			}

			const musicDir = getMusicDir()
			if (pathname.startsWith(ARTWORK_ROUTE_PREFIX)) {
				handleArtwork(
					res,
					headOnly,
					musicDir,
					pathname.slice(ARTWORK_ROUTE_PREFIX.length),
					getStore,
				)
				return
			}

			switch (pathname) {
				case STATUS_ROUTE:
					await handleStatus(res, headOnly, musicDir, scanner)
					break
				case FILES_ROUTE:
					await handleFiles(res, headOnly, musicDir)
					break
				case FILE_ROUTE:
					await handleFile(req, res, headOnly, musicDir, requestUrl)
					break
				case CATALOG_ROUTE:
					handleCatalog(res, headOnly, musicDir, scanner, getStore)
					break
				default:
					sendError(res, 404, 'FILE_NOT_FOUND', 'Not found', headOnly)
			}
		} catch (error) {
			console.error('[server-library] Unexpected error:', error)
			if (res.headersSent) {
				res.destroy()
				return
			}
			sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error', headOnly)
		}
	}

	return Object.assign(middleware, { waitForScanIdle: () => scanner.waitForIdle() })
}
