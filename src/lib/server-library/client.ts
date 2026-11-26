/**
 * Browser-side fetch helpers for the server library API.
 * Shared between the main thread and the scanner Web Worker:
 * both must build URLs and interpret responses through this module only.
 */

import {
	getServerLibraryFileUrl,
	SERVER_LIBRARY_BASE_PATH,
	type ServerLibraryCatalogResponse,
	type ServerLibraryErrorCode,
	type ServerLibraryErrorResponse,
	type ServerLibraryScanStatus,
} from './api.ts'

// Canonical index/catalog types live in ./api.ts (task #14, CONTRACTS.md §10);
// this module re-exports them so existing importers keep working.
/** @public */
export type {
	ServerCatalogArtwork,
	ServerCatalogTrack,
	ServerLibraryCatalogResponse,
	ServerLibraryScanState,
	ServerLibraryScanStatus,
} from './api.ts'

export type ServerLibraryRequestErrorCode =
	| ServerLibraryErrorCode
	| 'AUTH_REQUIRED'
	| 'SCAN_IN_PROGRESS'
	| 'ARTWORK_NOT_FOUND'
	| 'SCAN_FAILED'
	| 'NETWORK_ERROR'
	| 'HTTP_ERROR'

export class ServerLibraryRequestError extends Error {
	readonly code: ServerLibraryRequestErrorCode
	readonly httpStatus: number

	constructor(code: ServerLibraryRequestErrorCode, httpStatus: number, message: string) {
		super(message)
		this.name = 'ServerLibraryRequestError'
		this.code = code
		this.httpStatus = httpStatus
	}
}

// The backend always sends a JSON error body; when it is missing or malformed
// we still want a stable code, so 404 maps to FILE_NOT_FOUND and 409 to
// SCAN_IN_PROGRESS (first catalog not ready yet).
const fallbackErrorCode = (status: number): ServerLibraryRequestErrorCode =>
	status === 404 ? 'FILE_NOT_FOUND' : status === 409 ? 'SCAN_IN_PROGRESS' : 'HTTP_ERROR'

const errorFromResponse = async (response: Response): Promise<ServerLibraryRequestError> => {
	let code = fallbackErrorCode(response.status)

	try {
		const body = (await response.json()) as Partial<ServerLibraryErrorResponse>
		if (body.error?.code) {
			code = body.error.code
		}
	} catch {
		// Keep the fallback code.
	}

	return new ServerLibraryRequestError(
		code,
		response.status,
		`Request failed with ${response.status}`,
	)
}

const fetchResponse = async (url: string, init?: RequestInit): Promise<Response> => {
	let response: Response
	try {
		response = await fetch(url, init)
	} catch (cause) {
		throw new ServerLibraryRequestError(
			'NETWORK_ERROR',
			0,
			cause instanceof Error ? cause.message : 'Network request failed',
		)
	}

	if (response.status === 401) {
		throw new ServerLibraryRequestError('AUTH_REQUIRED', 401, 'Authentication required')
	}

	if (!response.ok) {
		throw await errorFromResponse(response)
	}

	return response
}

const fetchJson = async <T>(url: string): Promise<T> => {
	const response = await fetchResponse(url)
	return (await response.json()) as T
}

/**
 * Returns the server library status, including the index scan progress when
 * the backend exposes it (CONTRACTS.md §10).
 * Throws {@link ServerLibraryRequestError} when the status cannot be fetched.
 */
export const fetchServerLibraryStatus = (): Promise<ServerLibraryScanStatus> =>
	fetchJson<ServerLibraryScanStatus>(`${SERVER_LIBRARY_BASE_PATH}/status`)

/**
 * Returns the complete catalog built from the last finished server index.
 * A 409 `SCAN_IN_PROGRESS` (first catalog not ready yet) rejects with
 * `code === 'SCAN_IN_PROGRESS'`; any other failure also rejects — callers
 * must not treat a failure as an empty library.
 */
/** @public */
export const fetchServerLibraryCatalog = (): Promise<ServerLibraryCatalogResponse> =>
	fetchJson<ServerLibraryCatalogResponse>(`${SERVER_LIBRARY_BASE_PATH}/catalog`)

/**
 * Idempotently requests a server-side rescan; resolves once the request is
 * accepted (202). The caller then polls {@link waitForServerLibraryScan}
 * until the index reaches a terminal state.
 */
/** @public */
export const requestServerLibraryRescan = async (): Promise<void> => {
	await fetchResponse(`${SERVER_LIBRARY_BASE_PATH}/rescan`, { method: 'POST' })
}

const ARTWORK_HASH_RE = /^[0-9a-f]{64}$/

/**
 * Downloads artwork bytes by content hash (CONTRACTS.md §10). Callers must
 * request a hash only when it is missing from IndexedDB.
 * A missing hash rejects with `code === 'ARTWORK_NOT_FOUND'`.
 */
/** @public */
export const fetchServerLibraryArtwork = async (hash: string): Promise<Blob> => {
	if (!ARTWORK_HASH_RE.test(hash)) {
		throw new ServerLibraryRequestError('ARTWORK_NOT_FOUND', 404, 'Malformed artwork hash')
	}

	const response = await fetchResponse(`${SERVER_LIBRARY_BASE_PATH}/artwork/${hash}`)
	return response.blob()
}

const SERVER_SCAN_POLL_INTERVAL_MS = 1000
/** A stuck server scan must not hang the scanner worker forever. */
const SERVER_SCAN_WAIT_TIMEOUT_MS = 15 * 60_000

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms)
	})

export interface WaitForServerLibraryScanOptions {
	/** Called with every polled status while the scan is still running. */
	onProgress?: (status: ServerLibraryScanStatus) => void
}

/**
 * Polls the scan status until the server index reaches a terminal state.
 * Resolves with the last status once the index is `ready`; rejects with
 * `SCAN_FAILED` when the server reports a scan error or the wait times out.
 */
/** @public */
export const waitForServerLibraryScan = async (
	options: WaitForServerLibraryScanOptions = {},
): Promise<ServerLibraryScanStatus> => {
	const deadline = Date.now() + SERVER_SCAN_WAIT_TIMEOUT_MS

	for (;;) {
		const status = await fetchServerLibraryStatus()

		if (!status.enabled) {
			throw new ServerLibraryRequestError(
				'SERVER_LIBRARY_DISABLED',
				503,
				'Server library is disabled',
			)
		}

		// Pre-index backends never send `state`; there is nothing to wait for.
		if (status.state === undefined || status.state === 'ready') {
			return status
		}

		if (status.state === 'error') {
			throw new ServerLibraryRequestError(
				'SCAN_FAILED',
				500,
				status.error ?? 'Server library scan failed',
			)
		}

		if (Date.now() >= deadline) {
			throw new ServerLibraryRequestError(
				'SCAN_FAILED',
				0,
				'Timed out waiting for the server library scan',
			)
		}

		options.onProgress?.(status)
		await delay(SERVER_SCAN_POLL_INTERVAL_MS)
	}
}

/**
 * Downloads a single server library file.
 * A missing file rejects with `code === 'FILE_NOT_FOUND'`.
 */
export const fetchServerLibraryFileBlob = async (path: string): Promise<Blob> => {
	const response = await fetchResponse(getServerLibraryFileUrl(path))
	return response.blob()
}
