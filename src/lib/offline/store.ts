import { getDatabase } from '#lib/db/database.ts'
import { dispatchDatabaseChangedEvent } from '#lib/db/events.ts'
import { isServerFileEntity } from '#lib/helpers/file-system.ts'
import type { Track } from '#lib/library/types.ts'

/**
 * A persistent offline copy of a server library track (§12).
 *
 * Records live in the `offlineTracks` store of the current per-profile
 * database, so profile isolation (§9) applies to downloads automatically:
 * the anonymous profile and every account each see only their own copies.
 */
export interface OfflineTrackRecord {
	/** Track uuid; also the primary key of the `offlineTracks` store. */
	trackUuid: string
	/** Original file name on the server (used to rebuild a File). */
	fileName: string
	/**
	 * Freshness markers copied from the server file descriptor at download
	 * time. A record is current while both still match the library entry.
	 */
	size: number
	lastModified: number
	/** When the copy was saved locally (Date.now()). */
	downloadedAt: number
	/** The audio payload. */
	blob: Blob
}

/** Returns the stored offline copy for the track, if any. */
export const getOfflineTrack = async (
	trackUuid: string,
): Promise<OfflineTrackRecord | undefined> => {
	const db = await getDatabase()

	return await db.get('offlineTracks', trackUuid)
}

/** Lists the uuids of all tracks that have an offline copy. */
export const listOfflineTrackUuids = async (): Promise<string[]> => {
	const db = await getDatabase()
	const keys = await db.getAllKeys('offlineTracks')

	return keys.map(String)
}

/**
 * Saves (or replaces) the offline copy of a server track.
 *
 * Only server-backed tracks can be downloaded; local files are already
 * on the device. The blob must be the complete file: a size mismatch
 * with the server descriptor means a truncated download and is rejected,
 * so a partial blob is never persisted. Storage errors (quota exceeded,
 * aborted transactions) propagate to the caller.
 */
export const saveOfflineTrack = async (track: Track, blob: Blob): Promise<OfflineTrackRecord> => {
	const { file } = track
	if (!isServerFileEntity(file)) {
		throw new Error('Only server library tracks can be saved for offline playback')
	}

	if (blob.size !== file.size) {
		throw new Error(
			`Refusing to save a truncated offline copy of "${track.uuid}": ` +
				`got ${blob.size} bytes, expected ${file.size}`,
		)
	}

	const record: OfflineTrackRecord = {
		trackUuid: track.uuid,
		fileName: file.name,
		size: file.size,
		lastModified: file.lastModified,
		downloadedAt: Date.now(),
		blob,
	}

	const db = await getDatabase()
	const tx = db.transaction('offlineTracks', 'readwrite')
	const store = tx.objectStore('offlineTracks')
	const existingKey = await store.getKey(track.uuid)
	await store.put(record)
	await tx.done

	dispatchDatabaseChangedEvent({
		storeName: 'offlineTracks',
		operation: existingKey === undefined ? 'add' : 'update',
		key: track.uuid,
	})

	return record
}

/** Removes the offline copy of the track, if present. */
export const removeOfflineTrack = async (trackUuid: string): Promise<void> => {
	const db = await getDatabase()
	const tx = db.transaction('offlineTracks', 'readwrite')
	const store = tx.objectStore('offlineTracks')
	const existingKey = await store.getKey(trackUuid)
	if (existingKey !== undefined) {
		await store.delete(trackUuid)
	}
	await tx.done

	if (existingKey === undefined) {
		return
	}

	dispatchDatabaseChangedEvent({
		storeName: 'offlineTracks',
		operation: 'delete',
		key: trackUuid,
	})
}

/**
 * Whether the stored copy still matches the library entry: both the size
 * and the last-modified marker must be unchanged (§12). A stale copy is
 * kept (a rescan must not delete downloads) but is only used as a
 * last-resort fallback when the network is unavailable.
 */
export const isOfflineTrackCurrent = (record: OfflineTrackRecord, track: Track): boolean =>
	isServerFileEntity(track.file) &&
	record.size === track.file.size &&
	record.lastModified === track.file.lastModified
