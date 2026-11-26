import { getDatabase } from '#lib/db/database.ts'
import { type FileEntity, isServerFileEntity } from '#lib/helpers/file-system.ts'
import { isAndroid, isChromiumBased } from '#lib/helpers/utils/ua.ts'
import type { ServerFileEntity } from '#lib/library/types.ts'
import { getOfflineTrack, type OfflineTrackRecord } from '#lib/offline/store.ts'
import { getAudioMimeType } from '#lib/server-library/api.ts'
import {
	fetchServerLibraryFileBlob,
	ServerLibraryRequestError,
} from '#lib/server-library/client.ts'

/** @public */
export type FileLoadFailReason = 'permission-denied' | 'not-found' | 'error'

/** @public */
export type ResolveResult = { status: 'loaded'; file: File } | { status: FileLoadFailReason }

const requestPermission = async (
	handle: FileSystemHandle,
	askPermission: boolean,
): Promise<'granted' | 'denied'> => {
	let mode = await handle.queryPermission({ mode: 'read' })

	if (mode === 'prompt' && askPermission) {
		try {
			mode = await handle.requestPermission({ mode: 'read' })
		} catch (error) {
			// requestPermission requires a user activation.
			// Swallow and treat as denial.
			console.error('[file-resolver] requestPermission error:', error)
		}
	}

	return mode === 'granted' ? 'granted' : 'denied'
}

const resolveRegular = async (
	entity: FileSystemFileHandle,
	askPermission: boolean,
): Promise<File | null> => {
	const permission = await requestPermission(entity, askPermission)
	if (permission === 'denied') {
		return null
	}

	return entity.getFile()
}

/**
 * Android Chromium regression: persisted FileSystemFileHandles fail with
 * net:ERR_FILE_NOT_FOUND when used with URL.createObjectURL.
 * Workaround: re-acquire the handle from the parent directory.
 * https://issues.chromium.org/issues/499064852
 */
const resolveAndroidWorkaround = async (
	directoryId: number,
	fileName: string,
	askPermission: boolean,
): Promise<File | null> => {
	const db = await getDatabase()
	const dir = await db.get('directories', directoryId)
	if (!dir || dir.kind === 'server') {
		return null
	}

	const permission = await requestPermission(dir.handle, askPermission)
	if (permission === 'denied') {
		return null
	}

	const fileHandle = await dir.handle.getFileHandle(fileName)
	return fileHandle.getFile()
}

interface ResolveTrackFileOptions {
	directoryId: number
	entity: FileEntity
	askPermission: boolean
	/** Stable track uuid; enables the offline copy for server tracks (§12). */
	trackUuid?: string
}

const fileFromOfflineRecord = (record: OfflineTrackRecord, name: string): File =>
	new File([record.blob], name, {
		type: getAudioMimeType(name) ?? record.blob.type,
		lastModified: record.lastModified,
	})

const resolveServerFile = async (
	entity: ServerFileEntity,
	trackUuid?: string,
): Promise<ResolveResult> => {
	let offlineRecord: OfflineTrackRecord | undefined
	if (trackUuid !== undefined) {
		try {
			offlineRecord = await getOfflineTrack(trackUuid)
		} catch (error) {
			// A broken offline store must not break online playback.
			console.error('[resolveTrackFile] offline store read failed:', error)
		}
	}

	const isCurrent =
		offlineRecord !== undefined &&
		offlineRecord.size === entity.size &&
		offlineRecord.lastModified === entity.lastModified

	if (offlineRecord !== undefined && isCurrent) {
		// Fresh offline copy: play it without touching the network (§12).
		return { status: 'loaded', file: fileFromOfflineRecord(offlineRecord, entity.name) }
	}

	try {
		const blob = await fetchServerLibraryFileBlob(entity.path)
		const file = new File([blob], entity.name, {
			type: getAudioMimeType(entity.name) ?? blob.type,
			lastModified: entity.lastModified,
		})

		// The fresh copy is played but not persisted: refreshing the offline
		// record is an explicit user action (downloads, §12).
		return { status: 'loaded', file }
	} catch (error) {
		if (error instanceof ServerLibraryRequestError && error.code === 'FILE_NOT_FOUND') {
			return { status: 'not-found' }
		}

		if (offlineRecord !== undefined) {
			// Stale copy is the last available version when the server
			// cannot be reached (§12). A present-but-gone file (404) is
			// not treated as a network failure.
			console.warn('[resolveTrackFile] server unavailable, using stale offline copy', error)
			return { status: 'loaded', file: fileFromOfflineRecord(offlineRecord, entity.name) }
		}

		console.error('[resolveTrackFile] server file', error)
		return { status: 'error' }
	}
}

/**
 * Resolves a FileEntity (FileSystemFileHandle, legacy File, server file, etc.) to a File.
 * Handles permission prompts and so on.
 * @public
 */
export const resolveTrackFile = async (
	options: ResolveTrackFileOptions,
): Promise<ResolveResult> => {
	const { directoryId, entity, askPermission, trackUuid } = options

	if (isServerFileEntity(entity)) {
		return resolveServerFile(entity, trackUuid)
	}

	try {
		let file: File | null = null

		if (entity instanceof File) {
			file = entity
		} else if (isAndroid() && isChromiumBased()) {
			file = await resolveAndroidWorkaround(directoryId, entity.name, askPermission)
		} else {
			file = await resolveRegular(entity, askPermission)
		}

		if (file) {
			return { status: 'loaded', file }
		}

		return { status: 'permission-denied' }
	} catch (error) {
		if (error instanceof DOMException && error.name === 'NotFoundError') {
			return { status: 'not-found' }
		}
		console.error('[resolveTrackFile]', error)
		return { status: 'error' }
	}
}
