import type { LocalFileEntity } from '#lib/helpers/file-system.ts'
import type { SERVER_DIRECTORY_ID } from '#lib/library/types.ts'

export interface TracksScanResult {
	/** Count of many tracks were newly added */
	newlyImported: number
	/** Index of currently scanned track */
	current: number
	/** Total count of tracks */
	total: number
	/** The scan aborted before completion, e.g. the server catalog could not be fetched */
	error?: boolean
	/** The server library API rejected the request because the session is missing or expired (401). */
	authRequired?: boolean
	/** `server-scan` while the worker waits for the server-side index; count then reflects server progress. */
	phase?: 'server-scan'
}

export interface TracksScanMessage {
	finished: boolean
	count: TracksScanResult
}

/** @public */
export type TracksScanOptions =
	| {
			action: 'directory-add' | 'directory-rescan'
			dirId: number
			dirHandle: FileSystemDirectoryHandle
	  }
	| {
			action: 'server-directory-add' | 'server-directory-rescan'
			dirId: typeof SERVER_DIRECTORY_ID
	  }
	// Used in the browsers which do not support `showDirectoryPicker`
	| {
			action: 'legacy-files-add'
			files: LocalFileEntity[]
	  }
