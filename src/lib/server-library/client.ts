/**
 * Browser-side fetch helpers for the server library API.
 * Shared between the main thread and the scanner Web Worker:
 * both must build URLs and interpret responses through this module only.
 */

import {
	getServerLibraryFileUrl,
	SERVER_LIBRARY_BASE_PATH,
	type ServerFileDescriptor,
	type ServerLibraryErrorCode,
	type ServerLibraryErrorResponse,
	type ServerLibraryFilesResponse,
	type ServerLibraryStatusResponse,
} from './api.ts'

export type ServerLibraryRequestErrorCode = ServerLibraryErrorCode | 'NETWORK_ERROR' | 'HTTP_ERROR'

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
// we still want a stable code, so 404 maps to FILE_NOT_FOUND.
const fallbackErrorCode = (status: number): ServerLibraryRequestErrorCode =>
	status === 404 ? 'FILE_NOT_FOUND' : 'HTTP_ERROR'

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

const fetchResponse = async (url: string): Promise<Response> => {
	let response: Response
	try {
		response = await fetch(url)
	} catch (cause) {
		throw new ServerLibraryRequestError(
			'NETWORK_ERROR',
			0,
			cause instanceof Error ? cause.message : 'Network request failed',
		)
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

/** Throws {@link ServerLibraryRequestError} when the status cannot be fetched. */
export const fetchServerLibraryStatus = (): Promise<ServerLibraryStatusResponse> =>
	fetchJson<ServerLibraryStatusResponse>(`${SERVER_LIBRARY_BASE_PATH}/status`)

/**
 * Returns the complete server library file listing.
 * Throws {@link ServerLibraryRequestError} on any failure — callers must not
 * treat a failure as an empty library.
 */
export const fetchServerLibraryFiles = async (): Promise<ServerFileDescriptor[]> => {
	const data = await fetchJson<ServerLibraryFilesResponse>(`${SERVER_LIBRARY_BASE_PATH}/files`)
	return data.files
}

/**
 * Downloads a single server library file.
 * A missing file rejects with `code === 'FILE_NOT_FOUND'`.
 */
export const fetchServerLibraryFileBlob = async (path: string): Promise<Blob> => {
	const response = await fetchResponse(getServerLibraryFileUrl(path))
	return response.blob()
}
