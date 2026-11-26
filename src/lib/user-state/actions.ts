/**
 * Server-first helpers for the existing library action functions
 * (CONTRACTS.md §9): while an account is active, playlists, favorites and
 * history are synchronized entities without offline optimistic writes — the
 * server action is applied first and the returned snapshot is then applied
 * locally. When `getCurrentUserId()` is `null` (local-only/static mode)
 * callers keep the previous local-only behavior and never call this module.
 */

import {
	FAVORITES_PLAYLIST_UUID,
	type UserStateAction,
	type UserStateSnapshot,
} from '#lib/auth/api.ts'
import { getDatabase } from '#lib/db/database.ts'
import { FAVORITE_PLAYLIST_ID } from '#lib/library/types.ts'
import { postUserStateActions } from './client.ts'
import { applyUserStateSnapshot, isServerTrackUuid } from './snapshot.ts'
import { noteSnapshotApplied } from './sync.ts'

/**
 * Sends one atomic batch of actions to the server and applies the returned
 * snapshot locally. Throws on any failure without touching local data.
 */
export const applyServerActions = async (
	actions: readonly [UserStateAction, ...UserStateAction[]],
): Promise<UserStateSnapshot> => {
	const snapshot = await postUserStateActions(actions)
	await applyUserStateSnapshot(snapshot)
	noteSnapshotApplied(snapshot.revision)

	return snapshot
}

/** Maps local numeric track ids to their stable server UUIDs, skipping local-only tracks. */
export const loadServerTrackUuids = async (
	trackIds: readonly number[],
): Promise<Map<number, string>> => {
	const db = await getDatabase()
	const byId = new Map<number, string>()

	await Promise.all(
		[...new Set(trackIds)].map(async (trackId) => {
			const track = await db.get('tracks', trackId)
			if (track !== undefined && isServerTrackUuid(track.uuid)) {
				byId.set(trackId, track.uuid)
			}
		}),
	)

	return byId
}

/** Wire UUID of a local playlist; the favorites pseudo-playlist maps to `favorites`. */
export const resolveWirePlaylistUuid = async (playlistId: number): Promise<string | undefined> => {
	if (playlistId === FAVORITE_PLAYLIST_ID) {
		return FAVORITES_PLAYLIST_UUID
	}

	const db = await getDatabase()
	const playlist = await db.get('playlists', playlistId)

	return playlist?.uuid
}

/**
 * Builds the server actions that remove every synced reference to the given
 * local tracks (playlist entries, favorites and history records), so track
 * cleanup never leaves dangling entries on the server (§9). Local-only
 * tracks produce no actions.
 */
export const buildTrackRemovalActions = async (
	trackIds: readonly number[],
): Promise<UserStateAction[]> => {
	const serverTrackUuids = await loadServerTrackUuids(trackIds)
	if (serverTrackUuids.size === 0) {
		return []
	}

	const db = await getDatabase()
	const actions: UserStateAction[] = []

	for (const [trackId, trackUuid] of serverTrackUuids) {
		const entries = await db.getAllFromIndex('playlistEntries', 'trackId', trackId)
		for (const entry of entries) {
			if (entry.playlistId === FAVORITE_PLAYLIST_ID) {
				actions.push({ action: 'favorite-set', trackUuid, favorite: false })
				continue
			}

			const playlistUuid = await resolveWirePlaylistUuid(entry.playlistId)
			if (playlistUuid !== undefined) {
				actions.push({ action: 'playlist-entry-remove', playlistUuid, trackUuid })
			}
		}

		const historyKeys = await db.getAllKeysFromIndex('playHistory', 'trackId', trackId)
		if (historyKeys.length > 0) {
			actions.push({ action: 'history-remove', trackUuid })
		}
	}

	return actions
}
