/**
 * Applies a server user-state snapshot (CONTRACTS.md §9) to the local
 * profile database.
 *
 * Wire records reference playlists and tracks by their stable UUIDs; this
 * module maps them to the local numeric IndexedDB ids. The mapping is
 * applied atomically in one transaction that touches only `playlists`,
 * `playlistEntries` and `playHistory` — tracks, albums, artists, images
 * and directories of the local library are never modified or cleared.
 *
 * Entries and history records whose track is not present in this device's
 * library (for example scanned only on another device) are skipped: they
 * stay on the server and appear locally once the track is scanned here.
 * Records whose track has no server identity at all (local-only tracks)
 * are never part of the server state and are kept untouched by the diff.
 * Unchanged records keep their numeric ids, so open UI selections survive
 * a poll.
 */

import { FAVORITES_PLAYLIST_UUID, type UserStateSnapshot } from '#lib/auth/api.ts'
import { getDatabase } from '#lib/db/database.ts'
import { type DatabaseChangeDetails, dispatchDatabaseChangedEvent } from '#lib/db/events.ts'
import {
	FAVORITE_PLAYLIST_ID,
	type PlayHistoryEntry,
	type Playlist,
	type PlaylistEntry,
	type Track,
} from '#lib/library/types.ts'

/** Stable cross-device track identity exists only for server library tracks. */
export const isServerTrackUuid = (uuid: string): boolean => uuid.startsWith('server:')

const wirePlaylistId = (
	playlistUuid: string,
	playlistIdByUuid: ReadonlyMap<string, number>,
): number | undefined =>
	playlistUuid === FAVORITES_PLAYLIST_UUID
		? FAVORITE_PLAYLIST_ID
		: playlistIdByUuid.get(playlistUuid)

const entryIdentity = (playlistId: number, trackId: number): string => `${playlistId}:${trackId}`

/**
 * Replaces the local playlists/entries/history with the snapshot contents
 * and notifies listeners through {@link dispatchDatabaseChangedEvent}.
 * Returns the applied snapshot revision.
 */
export const applyUserStateSnapshot = async (snapshot: UserStateSnapshot): Promise<number> => {
	const db = await getDatabase()
	const tx = db.transaction(
		['playlists', 'playlistEntries', 'playHistory', 'tracks'],
		'readwrite',
	)
	const playlistsStore = tx.objectStore('playlists')
	const entriesStore = tx.objectStore('playlistEntries')
	const historyStore = tx.objectStore('playHistory')
	const tracksStore = tx.objectStore('tracks')

	const changes: DatabaseChangeDetails[] = []

	// Stable server UUID -> local numeric track id, only for tracks that
	// exist in this device's library.
	const uniqueTrackUuids = new Set<string>()
	for (const entry of snapshot.playlistEntries) {
		uniqueTrackUuids.add(entry.trackUuid)
	}
	for (const entry of snapshot.history) {
		uniqueTrackUuids.add(entry.trackUuid)
	}

	const trackIdByUuid = new Map<string, number>()
	await Promise.all(
		[...uniqueTrackUuids].map(async (trackUuid) => {
			const trackId = await tracksStore.index('uuid').getKey(trackUuid)
			if (trackId !== undefined) {
				trackIdByUuid.set(trackUuid, trackId)
			}
		}),
	)

	// Records referencing local-only tracks (no `server:` UUID) are never
	// mirrored on the server, so the diff must keep them instead of treating
	// them as removed. Missing tracks are not local-only: their dangling
	// records are cleaned up like any other non-snapshot record.
	const trackById = new Map<number, Track | undefined>()
	const isLocalOnlyRecord = async (trackId: number): Promise<boolean> => {
		if (!trackById.has(trackId)) {
			trackById.set(trackId, await tracksStore.get(trackId))
		}

		const track = trackById.get(trackId)

		return track !== undefined && !isServerTrackUuid(track.uuid)
	}

	// Playlists: upsert by uuid, delete the ones missing from the snapshot.
	const existingPlaylists = await playlistsStore.getAll()
	const existingPlaylistByUuid = new Map(existingPlaylists.map((p) => [p.uuid, p]))
	const snapshotPlaylistUuids = new Set(snapshot.playlists.map((p) => p.uuid))

	for (const existing of existingPlaylists) {
		if (!snapshotPlaylistUuids.has(existing.uuid)) {
			await playlistsStore.delete(existing.id)
			changes.push({ storeName: 'playlists', operation: 'delete', key: existing.id })
		}
	}

	const playlistIdByUuid = new Map<string, number>()
	for (const wire of snapshot.playlists) {
		const existing = existingPlaylistByUuid.get(wire.uuid)

		if (existing === undefined) {
			const playlist: Omit<Playlist, 'id'> = {
				uuid: wire.uuid,
				name: wire.name,
				description: wire.description,
				createdAt: wire.createdAt,
			}
			const id = await playlistsStore.add(playlist as Playlist)
			playlistIdByUuid.set(wire.uuid, id)
			changes.push({ storeName: 'playlists', operation: 'add', key: id })
			continue
		}

		playlistIdByUuid.set(wire.uuid, existing.id)

		if (
			existing.name !== wire.name ||
			existing.description !== wire.description ||
			existing.createdAt !== wire.createdAt
		) {
			await playlistsStore.put({
				...existing,
				name: wire.name,
				description: wire.description,
				createdAt: wire.createdAt,
			})
			changes.push({ storeName: 'playlists', operation: 'update', key: existing.id })
		}
	}

	// Playlist entries: point-wise diff so unchanged entries keep their ids.
	const existingEntries = await entriesStore.getAll()
	const existingEntryByIdentity = new Map(
		existingEntries.map((entry) => [entryIdentity(entry.playlistId, entry.trackId), entry]),
	)

	const snapshotEntryIdentities = new Set<string>()
	for (const wire of snapshot.playlistEntries) {
		const playlistId = wirePlaylistId(wire.playlistUuid, playlistIdByUuid)
		const trackId = trackIdByUuid.get(wire.trackUuid)
		if (playlistId === undefined || trackId === undefined) {
			continue
		}

		const identity = entryIdentity(playlistId, trackId)
		snapshotEntryIdentities.add(identity)

		const existing = existingEntryByIdentity.get(identity)
		if (existing !== undefined && existing.addedAt === wire.addedAt) {
			continue
		}

		if (existing !== undefined) {
			await entriesStore.delete(existing.id)
			changes.push({
				storeName: 'playlistEntries',
				operation: 'delete',
				key: existing.id,
				value: existing,
			})
		}

		const entry: Omit<PlaylistEntry, 'id'> = { playlistId, trackId, addedAt: wire.addedAt }
		const id = await entriesStore.add(entry as PlaylistEntry)
		changes.push({
			storeName: 'playlistEntries',
			operation: 'add',
			key: id,
			value: { ...entry, id },
		})
	}

	for (const existing of existingEntries) {
		if (snapshotEntryIdentities.has(entryIdentity(existing.playlistId, existing.trackId))) {
			continue
		}
		if (await isLocalOnlyRecord(existing.trackId)) {
			continue
		}

		await entriesStore.delete(existing.id)
		changes.push({
			storeName: 'playlistEntries',
			operation: 'delete',
			key: existing.id,
			value: existing,
		})
	}

	// Play history: point-wise diff keyed by trackId (one record per track),
	// so unchanged records keep their ids. Local-only records are never part
	// of the server state and are kept untouched.
	const existingHistory = await historyStore.getAll()
	const snapshotPlayedAtByTrackId = new Map<number, number>()
	for (const wire of snapshot.history) {
		const trackId = trackIdByUuid.get(wire.trackUuid)
		if (trackId !== undefined) {
			snapshotPlayedAtByTrackId.set(trackId, wire.playedAt)
		}
	}

	let historyChanged = false
	const existingHistoryTrackIds = new Set<number>()
	for (const entry of existingHistory) {
		existingHistoryTrackIds.add(entry.trackId)

		const playedAt = snapshotPlayedAtByTrackId.get(entry.trackId)
		if (playedAt === undefined) {
			// Dropped by the server snapshot; local-only records stay.
			if (await isLocalOnlyRecord(entry.trackId)) {
				continue
			}

			await historyStore.delete(entry.id)
			historyChanged = true
			continue
		}

		if (entry.playedAt !== playedAt) {
			await historyStore.put({ ...entry, playedAt })
			historyChanged = true
		}
	}

	for (const [trackId, playedAt] of snapshotPlayedAtByTrackId) {
		if (existingHistoryTrackIds.has(trackId)) {
			continue
		}

		const entry: Omit<PlayHistoryEntry, 'id'> = { trackId, playedAt }
		await historyStore.add(entry as PlayHistoryEntry)
		historyChanged = true
	}

	if (historyChanged) {
		changes.push({ storeName: 'playHistory' })
	}

	await tx.done

	dispatchDatabaseChangedEvent(changes)

	return snapshot.revision
}
