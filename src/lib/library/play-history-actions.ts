import { getCurrentUserId } from '#lib/auth/client.ts'
import { getDatabase } from '#lib/db/database.ts'
import { dispatchDatabaseChangedEvent } from '#lib/db/events.ts'
import { createUIAction } from '#lib/helpers/ui-action.ts'
import { applyServerActions } from '#lib/user-state/actions.ts'
import { notifyUserStateSyncError } from '#lib/user-state/notify.ts'
import { isServerTrackUuid } from '#lib/user-state/snapshot.ts'
import type { PlayHistoryEntry } from './types.ts'

const PLAY_HISTORY_LIMIT = 100

const notifyPlayHistoryChange = () => {
	dispatchDatabaseChangedEvent({
		storeName: 'playHistory',
	})
}

export const dbAddToPlayHistory = async (trackId: number): Promise<void> => {
	if (getCurrentUserId() !== null) {
		const db = await getDatabase()
		const track = await db.get('tracks', trackId)

		if (track !== undefined && isServerTrackUuid(track.uuid)) {
			// Server-first (§9): on failure nothing is written locally and the
			// user sees an explicit sync error instead of a fake success.
			try {
				await applyServerActions([
					{ action: 'history-record', trackUuid: track.uuid, playedAt: Date.now() },
				])
			} catch (error) {
				notifyUserStateSyncError(error)
			}

			return
		}
	}

	const db = await getDatabase()
	const tx = db.transaction(['tracks', 'playHistory'], 'readwrite')
	const tracksStore = tx.objectStore('tracks')
	const store = tx.objectStore('playHistory')

	// Don't add orphaned history records for tracks that are no longer in library.
	const trackExists = (await tracksStore.count(trackId)) > 0
	if (!trackExists) {
		await tx.done
		return
	}

	const newEntry: Omit<PlayHistoryEntry, 'id'> = {
		trackId,
		playedAt: Date.now(),
	}

	const existingKey = await store.index('trackId').getKey(trackId)
	if (existingKey === undefined) {
		await store.add(newEntry as PlayHistoryEntry)
	} else {
		await store.put({
			...newEntry,
			id: existingKey,
		})
	}

	// Keep only the most recent PLAY_HISTORY_LIMIT entries.
	// Start at newest and jump over the records we keep, then delete the tail.
	let cursor = await store.index('playedAt').openCursor(null, 'prev')
	if (cursor !== null) {
		cursor = await cursor.advance(PLAY_HISTORY_LIMIT)
	}

	while (cursor !== null) {
		await cursor.delete()
		cursor = await cursor.continue()
	}

	await tx.done

	notifyPlayHistoryChange()
}

export const dbRemoveFromPlayHistory = async (trackId: number): Promise<void> => {
	if (getCurrentUserId() !== null) {
		const db = await getDatabase()
		const track = await db.get('tracks', trackId)

		if (track !== undefined && isServerTrackUuid(track.uuid)) {
			try {
				await applyServerActions([{ action: 'history-remove', trackUuid: track.uuid }])
			} catch (error) {
				notifyUserStateSyncError(error)
			}

			return
		}
	}

	const db = await getDatabase()
	const tx = db.transaction('playHistory', 'readwrite')
	const store = tx.objectStore('playHistory')

	const historyIds = await store.index('trackId').getAllKeys(trackId)
	await Promise.all(historyIds.map((id) => store.delete(id)))
	await tx.done

	notifyPlayHistoryChange()
}

const dbClearPlayHistory = async (): Promise<void> => {
	if (getCurrentUserId() !== null) {
		try {
			await applyServerActions([{ action: 'history-clear' }])
		} catch (error) {
			notifyUserStateSyncError(error)
		}

		return
	}

	const db = await getDatabase()
	await db.clear('playHistory')

	notifyPlayHistoryChange()
}

export const clearPlayHistory = createUIAction({
	action: dbClearPlayHistory,
	successMessage: false,
})
