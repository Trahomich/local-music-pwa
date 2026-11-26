import type { IDBPObjectStore } from 'idb'
import type { UserStateAction } from '#lib/auth/api.ts'
import { getCurrentUserId } from '#lib/auth/client.ts'
import { type AppDB, getDatabase } from '#lib/db/database.ts'
import { type DatabaseChangeDetails, dispatchDatabaseChangedEvent } from '#lib/db/events.ts'
import { keyRangePrefix } from '#lib/db/key-range.ts'
import { createUIAction } from '#lib/helpers/ui-action.ts'
import { truncate } from '#lib/helpers/utils/text.ts'
import type { Playlist, PlaylistEntry } from '#lib/library/types.ts'
import {
	applyServerActions,
	loadServerTrackUuids,
	resolveWirePlaylistUuid,
} from '#lib/user-state/actions.ts'
import { isServerTrackUuid } from '#lib/user-state/snapshot.ts'
import { FAVORITE_PLAYLIST_ID } from './types.ts'

export { FAVORITE_PLAYLIST_ID } from './types.ts'

export const dbCreatePlaylist = async (
	name: string,
	description: string,
	createdAt = Date.now(),
): Promise<number> => {
	if (getCurrentUserId() !== null) {
		// Server-first (§9): the playlist exists only after the server
		// applied it and the returned snapshot was written locally.
		const uuid = crypto.randomUUID()
		await applyServerActions([
			{ action: 'playlist-create', uuid, name, description, createdAt, updatedAt: createdAt },
		])

		const db = await getDatabase()
		const playlist = await db.getFromIndex('playlists', 'uuid', uuid)
		invariant(playlist, 'Created playlist is missing after the snapshot apply')

		return playlist.id
	}

	const db = await getDatabase()

	const newPlaylist: Omit<Playlist, 'id'> = {
		name,
		description,
		uuid: crypto.randomUUID(),
		createdAt,
	}

	const id = await db.add('playlists', newPlaylist as Playlist)

	dispatchDatabaseChangedEvent({
		operation: 'add',
		storeName: 'playlists',
		key: id,
	})

	return id
}

export const createPlaylist = async (name: string, description: string): Promise<void> => {
	try {
		await dbCreatePlaylist(name, description)

		snackbar(
			m.libraryPlaylistCreated({
				playlistName: truncate(name, 20),
			}),
		)
	} catch (error) {
		snackbar.unexpectedError(error)
	}
}

export interface UpdatePlaylistOptions {
	id: number
	name: string
	description: string
}

const dbUpdatePlaylist = async (options: UpdatePlaylistOptions): Promise<void> => {
	const db = await getDatabase()

	const id = options.id

	if (getCurrentUserId() !== null) {
		const playlist = await db.get('playlists', id)
		invariant(playlist, 'Playlist not found')

		await applyServerActions([
			{
				action: 'playlist-update',
				uuid: playlist.uuid,
				name: options.name,
				description: options.description,
				updatedAt: Date.now(),
			},
		])

		return
	}

	const tx = db.transaction('playlists', 'readwrite')
	const existingPlaylist = await tx.store.get(id)

	invariant(existingPlaylist, 'Playlist not found')

	const updatedPlaylist: Playlist = {
		...existingPlaylist,
		name: options.name,
		description: options.description,
	}

	await tx.store.put(updatedPlaylist)

	dispatchDatabaseChangedEvent({
		operation: 'update',
		storeName: 'playlists',
		key: id,
	})
}

export const updatePlaylist = async (options: UpdatePlaylistOptions): Promise<boolean> => {
	try {
		await dbUpdatePlaylist(options)

		snackbar({
			id: `playlist-updated-${options.id}`,
			message: m.libraryPlaylistUpdated(),
		})

		return true
	} catch (error) {
		snackbar.unexpectedError(error)

		return false
	}
}

export const dbRemovePlaylist = async (playlistId: number): Promise<void> => {
	const db = await getDatabase()

	if (getCurrentUserId() !== null) {
		const playlist = await db.get('playlists', playlistId)
		if (playlist === undefined) {
			return
		}

		// The server cascades the delete to the playlist's entries (§9).
		await applyServerActions([{ action: 'playlist-delete', uuid: playlist.uuid }])

		return
	}

	const tx = db.transaction(['playlists', 'playlistEntries'], 'readwrite')
	const entriesStore = tx.objectStore('playlistEntries')

	const entriesIds = await entriesStore
		.index('playlistTrack')
		.getAllKeys(keyRangePrefix<'playlistEntries', 'playlistTrack'>([playlistId]))

	await Promise.all([
		...entriesIds.map((id) => entriesStore.delete(id)),
		tx.objectStore('playlists').delete(playlistId),
		tx.done,
	])

	// We are not notifying about individual tracks removals
	// because we are removing the whole playlist
	dispatchDatabaseChangedEvent({
		operation: 'delete',
		storeName: 'playlists',
		key: playlistId,
	})
}

export type DbPlaylistEntriesStore = IDBPObjectStore<
	AppDB,
	['playlistEntries'],
	'playlistEntries',
	'readwrite'
>

export const getPlaylistEntriesDatabaseStore = async (): Promise<DbPlaylistEntriesStore> => {
	const db = await getDatabase()
	const tx = db.transaction('playlistEntries', 'readwrite')
	const store = tx.objectStore('playlistEntries')

	return store
}

export interface AddTracksToPlaylistOptions {
	playlistIds: readonly number[]
	trackIds: readonly number[]
}

export const dbAddTracksToPlaylistsWithTx = (
	store: DbPlaylistEntriesStore,
	options: AddTracksToPlaylistOptions,
) => {
	const promises = options.trackIds.flatMap((trackId) =>
		options.playlistIds.map(async (playlistId) => {
			const playlistEntry: Omit<PlaylistEntry, 'id'> = {
				playlistId,
				trackId,
				addedAt: Date.now(),
			}

			const playlistEntryId = await store.add(playlistEntry as PlaylistEntry)

			const change: DatabaseChangeDetails = {
				storeName: 'playlistEntries',
				key: playlistEntryId,
				operation: 'add',
				value: {
					...playlistEntry,
					id: playlistEntryId,
				},
			}

			return change
		}),
	)

	return Promise.all(promises)
}

interface RemoveTracksFromPlaylistOptions {
	playlistIds: readonly number[]
	trackIds: readonly number[]
}

export const dbRemoveTracksFromPlaylistsWithTx = async (
	store: DbPlaylistEntriesStore,
	options: RemoveTracksFromPlaylistOptions,
) => {
	const { playlistIds, trackIds } = options

	const trackIdIndex = store.index('trackId')
	const changes: DatabaseChangeDetails[] = []

	for (const trackId of trackIds) {
		for await (const cursor of trackIdIndex.iterate(trackId)) {
			if (playlistIds.includes(cursor.value.playlistId)) {
				await cursor.delete()
				changes.push({
					storeName: 'playlistEntries',
					operation: 'delete',
					key: cursor.primaryKey,
					value: cursor.value,
				})
			}
		}
	}

	return changes
}

interface BatchModifyPlaylistSelectionOptions {
	trackIds: readonly number[]
	playlistsIdsAddTo: readonly number[]
	playlistsIdsRemoveFrom: readonly number[]
}

/**
 * Applies the selection through the server (§9): every (playlist, track)
 * pair becomes one idempotent wire action in a single atomic batch. The
 * returned snapshot already contains the resulting entries, so only
 * local-only tracks additionally go through the plain local path — they
 * never leave this device.
 */
const syncBatchModifyPlaylistsSelection = async (
	options: BatchModifyPlaylistSelectionOptions,
): Promise<boolean> => {
	const { trackIds, playlistsIdsAddTo, playlistsIdsRemoveFrom } = options

	const serverTrackUuids = await loadServerTrackUuids(trackIds)
	const localTrackIds = trackIds.filter((trackId) => !serverTrackUuids.has(trackId))

	const actions: UserStateAction[] = []

	for (const trackUuid of serverTrackUuids.values()) {
		for (const playlistId of playlistsIdsAddTo) {
			if (playlistId === FAVORITE_PLAYLIST_ID) {
				actions.push({ action: 'favorite-set', trackUuid, favorite: true })
			} else {
				const playlistUuid = await resolveWirePlaylistUuid(playlistId)
				if (playlistUuid !== undefined) {
					actions.push({
						action: 'playlist-entry-add',
						playlistUuid,
						trackUuid,
						addedAt: Date.now(),
					})
				}
			}
		}

		for (const playlistId of playlistsIdsRemoveFrom) {
			if (playlistId === FAVORITE_PLAYLIST_ID) {
				actions.push({ action: 'favorite-set', trackUuid, favorite: false })
			} else {
				const playlistUuid = await resolveWirePlaylistUuid(playlistId)
				if (playlistUuid !== undefined) {
					actions.push({ action: 'playlist-entry-remove', playlistUuid, trackUuid })
				}
			}
		}
	}

	let synced = false
	if (actions.length > 0) {
		await applyServerActions(actions as [UserStateAction, ...UserStateAction[]])
		synced = true
	}

	let localChanged = false
	if (localTrackIds.length > 0) {
		localChanged = await dbBatchModifyPlaylistsSelection({
			trackIds: localTrackIds,
			playlistsIdsAddTo,
			playlistsIdsRemoveFrom,
		})
	}

	return synced || localChanged
}

export const dbBatchModifyPlaylistsSelection = async (
	options: BatchModifyPlaylistSelectionOptions,
): Promise<boolean> => {
	const { trackIds, playlistsIdsAddTo, playlistsIdsRemoveFrom } = options

	if (getCurrentUserId() !== null) {
		return syncBatchModifyPlaylistsSelection(options)
	}

	const store = await getPlaylistEntriesDatabaseStore()

	const allChanges: DatabaseChangeDetails[] = []
	if (playlistsIdsRemoveFrom.length > 0) {
		const changes = await dbRemoveTracksFromPlaylistsWithTx(store, {
			playlistIds: playlistsIdsRemoveFrom,
			trackIds,
		})
		allChanges.push(...changes)
	}

	if (playlistsIdsAddTo.length > 0) {
		const changes = await dbAddTracksToPlaylistsWithTx(store, {
			playlistIds: playlistsIdsAddTo,
			trackIds,
		})
		allChanges.push(...changes)
	}

	dispatchDatabaseChangedEvent(allChanges)

	return allChanges.length > 0
}

const dbRemoveTrackEntryFromPlaylist = async (playlistEntryId: number): Promise<void> => {
	const db = await getDatabase()

	const entry = await db.get('playlistEntries', playlistEntryId)
	invariant(entry)

	if (getCurrentUserId() !== null) {
		const track = await db.get('tracks', entry.trackId)

		if (track !== undefined && isServerTrackUuid(track.uuid)) {
			if (entry.playlistId === FAVORITE_PLAYLIST_ID) {
				await applyServerActions([
					{ action: 'favorite-set', trackUuid: track.uuid, favorite: false },
				])
			} else {
				const playlist = await db.get('playlists', entry.playlistId)
				invariant(playlist, 'Playlist not found')

				await applyServerActions([
					{
						action: 'playlist-entry-remove',
						playlistUuid: playlist.uuid,
						trackUuid: track.uuid,
					},
				])
			}

			return
		}
		// Local-only entries stay local (§9) and use the plain path below.
	}

	await db.delete('playlistEntries', entry.id)

	dispatchDatabaseChangedEvent({
		operation: 'delete',
		storeName: 'playlistEntries',
		key: entry.id,
		value: entry,
	})
}

export const removeTrackEntryFromPlaylist = createUIAction({
	action: dbRemoveTrackEntryFromPlaylist,
	successMessage: m.libraryTrackRemovedFromPlaylist(),
})

const dbAddTrackToFavorites = async (trackId: number): Promise<void> => {
	if (getCurrentUserId() !== null) {
		const db = await getDatabase()
		const track = await db.get('tracks', trackId)
		invariant(track, 'Track not found')

		if (isServerTrackUuid(track.uuid)) {
			await applyServerActions([
				{ action: 'favorite-set', trackUuid: track.uuid, favorite: true },
			])

			return
		}
	}

	const db = await getDatabase()

	// Check if already exists to prevent duplicates
	const existing = await db.getFromIndex('playlistEntries', 'playlistTrack', [
		FAVORITE_PLAYLIST_ID,
		trackId,
	])

	if (existing) {
		return
	}

	const playlistEntry: Omit<PlaylistEntry, 'id'> = {
		playlistId: FAVORITE_PLAYLIST_ID,
		trackId,
		addedAt: Date.now(),
	}

	const key = await db.add('playlistEntries', playlistEntry as PlaylistEntry)

	dispatchDatabaseChangedEvent({
		operation: 'add',
		storeName: 'playlistEntries',
		key,
		value: {
			...playlistEntry,
			id: key,
		},
	})
}

const dbRemoveTrackFromFavorites = async (trackId: number): Promise<void> => {
	if (getCurrentUserId() !== null) {
		const db = await getDatabase()
		const track = await db.get('tracks', trackId)
		invariant(track, 'Track not found')

		if (isServerTrackUuid(track.uuid)) {
			await applyServerActions([
				{ action: 'favorite-set', trackUuid: track.uuid, favorite: false },
			])

			return
		}
	}

	const db = await getDatabase()

	const entry = await db.getFromIndex('playlistEntries', 'playlistTrack', [
		FAVORITE_PLAYLIST_ID,
		trackId,
	])
	invariant(entry)

	await db.delete('playlistEntries', entry.id)

	dispatchDatabaseChangedEvent({
		operation: 'delete',
		storeName: 'playlistEntries',
		key: entry.id,
		value: entry,
	})
}

export const toggleFavoriteTrack = async (
	shouldBeRemoved: boolean,
	trackId: number,
): Promise<boolean> => {
	try {
		if (shouldBeRemoved) {
			await dbRemoveTrackFromFavorites(trackId)
		} else {
			await dbAddTrackToFavorites(trackId)
		}

		return true
	} catch (error) {
		snackbar.unexpectedError(error)

		return false
	}
}
