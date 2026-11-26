/**
 * Isomorphic contract of the server music library HTTP API.
 *
 * Shared by the Node backend (`server/`), the browser client and tests.
 * Must stay free of Node/DOM dependencies.
 */
import type { ParsedTrackData } from '#lib/library/types.ts'

/** @public */
export const SERVER_LIBRARY_BASE_PATH = '/api/server-library'

/** A single audio file exposed by the server library. `path` is a relative POSIX path without a leading `/`. */
/** @public */
export interface ServerFileDescriptor {
	path: string
	name: string
	size: number
	lastModified: number
}

/** @public */
export interface ServerLibraryStatusResponse {
	enabled: boolean
}

/** Server-side index scan lifecycle (CONTRACTS.md §10). */
/** @public */
export type ServerLibraryScanState = 'scanning' | 'ready' | 'error'

/**
 * Scan status of the server-side music index. `state`, `current` and `total`
 * are present when the library is enabled; `error` appears only in the `error`
 * state and never contains host paths.
 */
/** @public */
export interface ServerLibraryScanStatus extends ServerLibraryStatusResponse {
	state?: ServerLibraryScanState
	current?: number
	total?: number
	error?: string
}

/** Content-addressed artwork reference of a catalog track. Bytes are served by `GET artwork/<hash>`. */
/** @public */
export interface ServerCatalogArtwork {
	hash: string
	mimeType: string
}

/** One catalog track: file descriptor plus metadata parsed once on the server (CONTRACTS.md §10). */
/** @public */
export interface ServerCatalogTrack {
	descriptor: ServerFileDescriptor
	/** Stable cross-device identity: `'server:' + sha256(path)`. */
	uuid: string
	/** Normalized track metadata matching the browser `ParsedTrackData` shape. */
	data: ParsedTrackData
	artwork?: ServerCatalogArtwork
}

/** Response of `GET /api/server-library/catalog`: the last completed index only. */
/** @public */
export interface ServerLibraryCatalogResponse {
	revision: number
	tracks: ServerCatalogTrack[]
}

/** Response of `POST /api/server-library/rescan` (202). */
/** @public */
export interface ServerLibraryRescanResponse {
	state: 'scanning'
}

/** @public */
export interface ServerLibraryFilesResponse {
	files: ServerFileDescriptor[]
}

/** @public */
export type ServerLibraryErrorCode =
	| 'SERVER_LIBRARY_DISABLED'
	| 'INVALID_PATH'
	| 'FILE_NOT_FOUND'
	| 'DIRECTORY_UNAVAILABLE'
	| 'INTERNAL_ERROR'
	| 'SCAN_IN_PROGRESS'
	| 'ARTWORK_NOT_FOUND'

/** @public */
export interface ServerLibraryErrorResponse {
	error: {
		code: ServerLibraryErrorCode
		message: string
	}
}

/** Supported audio file extensions (lowercase, without dot). The local import uses the same list. */
/** @public */
export const AUDIO_FILE_EXTENSIONS = [
	'aac',
	'mp3',
	'ogg',
	'wav',
	'flac',
	'm4a',
	'opus',
	'webm',
] as const

/** @public */
export type AudioFileExtension = (typeof AUDIO_FILE_EXTENSIONS)[number]

const AUDIO_MIME_TYPES: Record<AudioFileExtension, string> = {
	aac: 'audio/aac',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	opus: 'audio/ogg',
	webm: 'audio/webm',
}

/**
 * Returns the lowercase extension when it is a supported audio extension, otherwise `undefined`.
 * @public
 */
export const getAudioFileExtension = (fileName: string): AudioFileExtension | undefined => {
	const dotIndex = fileName.lastIndexOf('.')
	if (dotIndex === -1) {
		return undefined
	}

	const extension = fileName.slice(dotIndex + 1).toLowerCase()
	return (AUDIO_FILE_EXTENSIONS as readonly string[]).includes(extension)
		? (extension as AudioFileExtension)
		: undefined
}

/** @public */
export const isSupportedAudioFileName = (fileName: string): boolean =>
	getAudioFileExtension(fileName) !== undefined

/** @public */
export const getAudioMimeType = (fileName: string): string | undefined => {
	const extension = getAudioFileExtension(fileName)
	return extension === undefined ? undefined : AUDIO_MIME_TYPES[extension]
}

/** Builds the download URL of a server library file. Clients must not assemble this URL themselves. */
/** @public */
export const getServerLibraryFileUrl = (path: string): string =>
	`${SERVER_LIBRARY_BASE_PATH}/file?path=${encodeURIComponent(path)}`
