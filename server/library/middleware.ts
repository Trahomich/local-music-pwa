import { createReadStream, type Stats } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, sep } from 'node:path'
import {
	getAudioMimeType,
	SERVER_LIBRARY_BASE_PATH,
	type ServerFileDescriptor,
	type ServerLibraryErrorCode,
} from '../../src/lib/server-library/api.ts'

type NextFunction = (error?: unknown) => void

const STATUS_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/status`
const FILES_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/files`
const FILE_ROUTE = `${SERVER_LIBRARY_BASE_PATH}/file`

const isErrorCode = (error: unknown, code: string): boolean =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === code

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

/** Resolves `MUSIC_DIR` to its real path, or `undefined` when it is not a readable directory. */
const resolveMusicDir = async (musicDir: string): Promise<string | undefined> => {
	try {
		const [realDir, dirStat] = await Promise.all([realpath(musicDir), stat(musicDir)])
		return dirStat.isDirectory() ? realDir : undefined
	} catch {
		return undefined
	}
}

const collectAudioFiles = async (rootDir: string): Promise<ServerFileDescriptor[]> => {
	const files: ServerFileDescriptor[] = []

	const walk = async (directory: string, segments: string[]): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true })

		for (const entry of entries) {
			// Never follow symbolic links, neither to files nor to directories
			if (entry.isSymbolicLink()) {
				continue
			}

			if (entry.isDirectory()) {
				await walk(resolve(directory, entry.name), [...segments, entry.name])
				continue
			}

			if (!entry.isFile() || getAudioMimeType(entry.name) === undefined) {
				continue
			}

			let fileStat: Stats
			try {
				fileStat = await stat(resolve(directory, entry.name))
			} catch (error) {
				// The file may disappear between readdir and stat; skip it instead of failing the whole index
				if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTDIR')) {
					continue
				}
				throw error
			}

			files.push({
				path: [...segments, entry.name].join('/'),
				name: entry.name,
				size: fileStat.size,
				lastModified: Math.round(fileStat.mtimeMs),
			})
		}
	}

	await walk(rootDir, [])
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	return files
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

	sendJson(res, 200, { enabled: true }, headOnly)
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

/**
 * Connect-style middleware serving the read-only server music library API.
 * Handles only URLs under `/api/server-library`; everything else is passed to `next()`.
 *
 * By default `getMusicDir` reads `process.env.MUSIC_DIR` on every request, so an empty
 * or missing value disables the library (but not the player) without a restart.
 * @public
 */
export const createServerLibraryMiddleware =
	(getMusicDir: () => string | undefined = () => process.env.MUSIC_DIR || undefined) =>
	async (req: IncomingMessage, res: ServerResponse, next: NextFunction): Promise<void> => {
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
			if (req.method !== 'GET' && !headOnly) {
				res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' })
				res.end()
				return
			}

			const musicDir = getMusicDir()
			switch (pathname) {
				case STATUS_ROUTE:
					await handleStatus(res, headOnly, musicDir)
					break
				case FILES_ROUTE:
					await handleFiles(res, headOnly, musicDir)
					break
				case FILE_ROUTE:
					await handleFile(req, res, headOnly, musicDir, requestUrl)
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
