// Test-only fetch mock of the server library HTTP API (CONTRACTS.md §4, §10).
import { vi } from 'vitest'
import type { ParsedTrackData } from '#lib/library/types.ts'
import type { ServerFileDescriptor } from '#lib/server-library/api.ts'
import type {
	ServerCatalogArtwork,
	ServerCatalogTrack,
	ServerLibraryCatalogResponse,
	ServerLibraryRequestErrorCode,
	ServerLibraryScanStatus,
} from '#lib/server-library/client.ts'

export interface ServerLibraryRequestRecord {
	method: string
	pathname: string
	queryPath: string | null
}

export interface ServerLibraryMockState {
	files: ServerFileDescriptor[]
	listStatus: number
	fileStatuses: Record<string, number>
	networkError: boolean
	/** Tracks returned by GET /catalog. */
	catalogTracks: ServerCatalogTrack[]
	/** HTTP statuses returned by GET /catalog in order; the last one repeats. */
	catalogStatuses: number[]
	/** Bodies returned by GET /status in order; the last one repeats. */
	scanStatuses: ServerLibraryScanStatus[]
	/** HTTP status returned by POST /rescan. */
	rescanStatus: number
	/** Artwork bytes per hash; hashes absent here answer 404 ARTWORK_NOT_FOUND. */
	artworkBodies: Record<string, string>
}

const SERVER_LIBRARY_MIME_BY_EXT: Record<string, string> = {
	aac: 'audio/aac',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	opus: 'audio/ogg',
	webm: 'audio/webm',
}

// Stable error codes the real backend sends for each HTTP status (CONTRACTS.md §4, §10).
const ERROR_CODE_BY_STATUS: Record<number, ServerLibraryRequestErrorCode> = {
	400: 'INVALID_PATH',
	401: 'AUTH_REQUIRED',
	404: 'FILE_NOT_FOUND',
	409: 'SCAN_IN_PROGRESS',
	500: 'INTERNAL_ERROR',
	503: 'DIRECTORY_UNAVAILABLE',
}

const FILE_EXTENSION_RE = /\.[^.]+$/

/** MIME type the file endpoint returns for a relative path (CONTRACTS.md §4). */
/** @public */
export const serverFileMime = (path: string): string => {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
	return SERVER_LIBRARY_MIME_BY_EXT[extension] ?? 'application/octet-stream'
}

/** Deterministic payload per relative path so descriptor size can match real bytes. */
/** @public */
export const serverFileBody = (path: string): string => `server-bytes:${path}`

/** @public */
export const serverFileDescriptor = (
	path: string,
	overrides: Partial<ServerFileDescriptor> = {},
): ServerFileDescriptor => ({
	path,
	name: path.slice(path.lastIndexOf('/') + 1),
	size: new TextEncoder().encode(serverFileBody(path)).length,
	lastModified: 1_764_057_600_000,
	...overrides,
})

/** A deterministic 64-lowercase-hex artwork hash fixture (CONTRACTS.md §10). */
/** @public */
export const SERVER_ARTWORK_HASH = 'ab'.repeat(32)

/** @public */
export const serverCatalogArtwork = (hash = SERVER_ARTWORK_HASH): ServerCatalogArtwork => ({
	hash,
	mimeType: 'image/jpeg',
})

/**
 * A catalog entry fixture with server-parsed metadata. The uuid is a
 * deterministic stand-in for the stable 'server:'+sha256(path) identity;
 * `metadataVersion` is intentionally absent — the client must stamp it.
 */
/** @public */
export const serverCatalogTrack = (
	descriptor: ServerFileDescriptor,
	overrides: Partial<ServerCatalogTrack> = {},
): ServerCatalogTrack => {
	const extension = descriptor.name.slice(descriptor.name.lastIndexOf('.') + 1).toLowerCase()

	return {
		descriptor,
		uuid: `server:mock:${descriptor.path}`,
		data: {
			name: descriptor.name.replace(FILE_EXTENSION_RE, ''),
			album: 'Server Album',
			artists: ['Server Artist'],
			year: '2024',
			duration: 180,
			genre: [],
			trackNo: 1,
			trackOf: 1,
			discNo: 1,
			discOf: 1,
			format: { codec: extension },
		} satisfies ParsedTrackData,
		...overrides,
	}
}

const jsonResponse = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})

const errorResponse = (status: number): Response =>
	jsonResponse(
		{
			error: {
				code: ERROR_CODE_BY_STATUS[status] ?? 'INTERNAL_ERROR',
				message: 'mock error',
			},
		},
		status,
	)

/** Returns queued values one by one, then repeats the last one forever. Reads the live array, so tests may replace it. */
const sequential = <T>(getItems: () => T[], fallback: T): (() => T) => {
	let last = fallback

	return () => {
		const next = getItems().shift()
		if (next !== undefined) {
			last = next
		}
		return last
	}
}

/**
 * Installs a global fetch serving the server library API from in-memory state.
 * Pair with vi.unstubAllGlobals() in afterEach.
 */
/** @public */
export const installServerLibraryMock = (
	initial: Partial<ServerLibraryMockState> = {},
): { requests: ServerLibraryRequestRecord[]; state: ServerLibraryMockState } => {
	const requests: ServerLibraryRequestRecord[] = []
	const state: ServerLibraryMockState = {
		files: initial.files ?? [],
		listStatus: initial.listStatus ?? 200,
		fileStatuses: initial.fileStatuses ?? {},
		networkError: initial.networkError ?? false,
		catalogTracks: initial.catalogTracks ?? [],
		catalogStatuses: initial.catalogStatuses ?? [200],
		scanStatuses: initial.scanStatuses ?? [
			{ enabled: true, state: 'ready', current: 0, total: 0 },
		],
		rescanStatus: initial.rescanStatus ?? 202,
		artworkBodies: initial.artworkBodies ?? {},
	}

	const nextCatalogStatus = sequential(() => state.catalogStatuses, 200)
	const nextScanStatus = sequential(() => state.scanStatuses, { enabled: true, state: 'ready' })

	const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
		const url =
			typeof input === 'string'
				? new URL(input, 'http://server-library.test')
				: new URL((input as Request).url, 'http://server-library.test')
		const method =
			typeof input === 'object' && input !== null && 'method' in input
				? String((input as Request).method)
				: (init?.method ?? 'GET')

		requests.push({ method, pathname: url.pathname, queryPath: url.searchParams.get('path') })

		if (state.networkError) {
			return Promise.reject(new TypeError('fetch failed'))
		}

		if (url.pathname === '/api/server-library/status') {
			return Promise.resolve(jsonResponse(nextScanStatus(), 200))
		}

		if (url.pathname === '/api/server-library/rescan') {
			if (state.rescanStatus !== 202) {
				return Promise.resolve(errorResponse(state.rescanStatus))
			}
			return Promise.resolve(jsonResponse({ state: 'scanning' }, 202))
		}

		if (url.pathname === '/api/server-library/catalog') {
			const status = nextCatalogStatus()
			if (status !== 200) {
				return Promise.resolve(errorResponse(status))
			}
			const body: ServerLibraryCatalogResponse = { revision: 1, tracks: state.catalogTracks }
			return Promise.resolve(jsonResponse(body, 200))
		}

		if (url.pathname.startsWith('/api/server-library/artwork/')) {
			const hash = url.pathname.slice('/api/server-library/artwork/'.length)
			const body = state.artworkBodies[hash]
			if (body === undefined) {
				return Promise.resolve(
					jsonResponse(
						{ error: { code: 'ARTWORK_NOT_FOUND', message: 'mock error' } },
						404,
					),
				)
			}
			const mimeType =
				state.catalogTracks.find((track) => track.artwork?.hash === hash)?.artwork
					?.mimeType ?? 'image/jpeg'
			return Promise.resolve(
				new Response(body, {
					status: 200,
					headers: {
						'content-type': mimeType,
						'cache-control': 'public,max-age=31536000,immutable',
					},
				}),
			)
		}

		if (url.pathname === '/api/server-library/files') {
			if (state.listStatus !== 200) {
				return Promise.resolve(errorResponse(state.listStatus))
			}
			return Promise.resolve(jsonResponse({ files: state.files }, 200))
		}

		if (url.pathname === '/api/server-library/file') {
			const path = url.searchParams.get('path')
			const status = path === null ? 400 : (state.fileStatuses[path] ?? 200)
			if (path === null || status !== 200) {
				return Promise.resolve(errorResponse(status))
			}
			const body = serverFileBody(path)
			return Promise.resolve(
				new Response(body, {
					status: 200,
					headers: {
						'content-type': serverFileMime(path),
						'content-length': String(new TextEncoder().encode(body).length),
						'accept-ranges': 'bytes',
					},
				}),
			)
		}

		return Promise.resolve(errorResponse(404))
	})

	vi.stubGlobal('fetch', fetchMock)

	return { requests, state }
}
