// Test-only fetch mock of the read-only server library HTTP API (CONTRACTS.md §4).
import { vi } from 'vitest'
import type { ServerFileDescriptor, ServerLibraryErrorCode } from '#lib/server-library/api.ts'

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

// Stable error codes the real backend sends for each HTTP status (CONTRACTS.md §4).
const ERROR_CODE_BY_STATUS: Record<number, ServerLibraryErrorCode> = {
	400: 'INVALID_PATH',
	404: 'FILE_NOT_FOUND',
	503: 'DIRECTORY_UNAVAILABLE',
	500: 'INTERNAL_ERROR',
}

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

/**
 * Installs a global fetch serving the read-only server library API from in-memory state.
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
	}

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
