import type { DatabaseSync } from 'node:sqlite'
import {
	FAVORITES_PLAYLIST_UUID,
	USER_STATE_SNAPSHOT_VERSION,
	type UserStateAction,
	type UserStateSnapshot,
} from '../../src/lib/auth/api.ts'
import { isUniqueViolation } from '../auth/db.ts'

const HISTORY_LIMIT = 100

/** Domain error of a user-state action; maps to 400 INVALID_ACTION. */
/** @public */
export class UserStateActionError extends Error {}

export interface UserStateStore {
	getSnapshot: (userId: number) => UserStateSnapshot
	applyActions: (
		userId: number,
		actionId: string,
		actions: UserStateAction[],
	) => UserStateSnapshot
}

const runInTransaction = (db: DatabaseSync, run: () => void): void => {
	db.exec('BEGIN IMMEDIATE')
	try {
		run()
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

const requireNonEmptyString = (value: unknown, field: string): string => {
	if (typeof value !== 'string' || value === '') {
		throw new UserStateActionError(`Invalid action: ${field} must be a non-empty string`)
	}
	return value
}

const requireOptionalString = (value: unknown, field: string): string | undefined => {
	if (value === undefined) {
		return undefined
	}
	return requireNonEmptyString(value, field)
}

const requireTimestamp = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new UserStateActionError(`Invalid action: ${field} must be a non-negative integer`)
	}
	return value
}

const requireBoolean = (value: unknown, field: string): boolean => {
	if (typeof value !== 'boolean') {
		throw new UserStateActionError(`Invalid action: ${field} must be a boolean`)
	}
	return value
}

/** Validates one raw action from JSON, narrowing it to the typed union. */
/** @public */
export const parseUserStateAction = (raw: unknown): UserStateAction => {
	if (typeof raw !== 'object' || raw === null) {
		throw new UserStateActionError('Invalid action: expected an object')
	}

	const record = raw as Record<string, unknown>
	const action = record.action

	switch (action) {
		case 'playlist-create': {
			const uuid = requireNonEmptyString(record.uuid, 'uuid')
			if (uuid === FAVORITES_PLAYLIST_UUID) {
				throw new UserStateActionError(
					'Invalid action: the favorites playlist cannot be created',
				)
			}
			return {
				action,
				uuid,
				name: requireNonEmptyString(record.name, 'name'),
				description: requireOptionalString(record.description, 'description'),
				createdAt: requireTimestamp(record.createdAt, 'createdAt'),
				updatedAt: requireTimestamp(record.updatedAt, 'updatedAt'),
			}
		}
		case 'playlist-update': {
			const uuid = requireNonEmptyString(record.uuid, 'uuid')
			if (uuid === FAVORITES_PLAYLIST_UUID) {
				throw new UserStateActionError(
					'Invalid action: the favorites playlist cannot be updated',
				)
			}
			return {
				action,
				uuid,
				name: requireOptionalString(record.name, 'name'),
				description: requireOptionalString(record.description, 'description'),
				updatedAt: requireTimestamp(record.updatedAt, 'updatedAt'),
			}
		}
		case 'playlist-delete': {
			const uuid = requireNonEmptyString(record.uuid, 'uuid')
			if (uuid === FAVORITES_PLAYLIST_UUID) {
				throw new UserStateActionError(
					'Invalid action: the favorites playlist cannot be deleted',
				)
			}
			return { action, uuid }
		}
		case 'playlist-entry-add':
		case 'playlist-entry-remove': {
			const playlistUuid = requireNonEmptyString(record.playlistUuid, 'playlistUuid')
			const trackUuid = requireNonEmptyString(record.trackUuid, 'trackUuid')
			if (playlistUuid === FAVORITES_PLAYLIST_UUID) {
				throw new UserStateActionError(
					'Invalid action: favorites entries are changed through favorite-set',
				)
			}
			return action === 'playlist-entry-add'
				? {
						action,
						playlistUuid,
						trackUuid,
						addedAt: requireTimestamp(record.addedAt, 'addedAt'),
					}
				: { action, playlistUuid, trackUuid }
		}
		case 'favorite-set':
			return {
				action,
				trackUuid: requireNonEmptyString(record.trackUuid, 'trackUuid'),
				favorite: requireBoolean(record.favorite, 'favorite'),
			}
		case 'history-record':
			return {
				action,
				trackUuid: requireNonEmptyString(record.trackUuid, 'trackUuid'),
				playedAt: requireTimestamp(record.playedAt, 'playedAt'),
			}
		case 'history-remove':
			return { action, trackUuid: requireNonEmptyString(record.trackUuid, 'trackUuid') }
		case 'history-clear':
			return { action }
		default:
			throw new UserStateActionError(`Unknown action: ${String(action)}`)
	}
}

/**
 * Per-user playlists/favorites/history storage inside `auth.sqlite`.
 * Uses the connection owned by the auth domain; its schema lives in this module.
 * @public
 */
export const createUserStateStore = (db: DatabaseSync): UserStateStore => {
	const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number })
		.user_version
	if (currentVersion < 2) {
		runInTransaction(db, () => {
			db.exec(`
				CREATE TABLE playlists (
					user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					uuid TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (user_id, uuid)
				);
				CREATE TABLE playlist_entries (
					user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					playlist_uuid TEXT NOT NULL,
					track_uuid TEXT NOT NULL,
					added_at INTEGER NOT NULL,
					PRIMARY KEY (user_id, playlist_uuid, track_uuid)
				);
				CREATE TABLE history (
					user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					track_uuid TEXT NOT NULL,
					played_at INTEGER NOT NULL,
					PRIMARY KEY (user_id, track_uuid)
				);
				CREATE TABLE user_state_meta (
					user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
					revision INTEGER NOT NULL DEFAULT 0
				);
				CREATE TABLE applied_actions (
					user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					action_id TEXT NOT NULL,
					applied_at INTEGER NOT NULL,
					PRIMARY KEY (user_id, action_id)
				);
			`)
			db.exec('PRAGMA user_version = 2')
		})
	}

	const getRevision = (userId: number): number => {
		const row = db
			.prepare('SELECT revision FROM user_state_meta WHERE user_id = ?')
			.get(userId) as { revision: number } | undefined
		return row?.revision ?? 0
	}

	const getSnapshot = (userId: number): UserStateSnapshot => {
		const playlists = db
			.prepare(
				'SELECT uuid, name, description, created_at, updated_at FROM playlists WHERE user_id = ? ORDER BY created_at, uuid',
			)
			.all(userId) as {
			uuid: string
			name: string
			description: string
			created_at: number
			updated_at: number
		}[]
		const entries = db
			.prepare(
				'SELECT playlist_uuid, track_uuid, added_at FROM playlist_entries WHERE user_id = ? ORDER BY playlist_uuid, added_at, track_uuid',
			)
			.all(userId) as { playlist_uuid: string; track_uuid: string; added_at: number }[]
		const history = db
			.prepare(
				'SELECT track_uuid, played_at FROM history WHERE user_id = ? ORDER BY played_at DESC, track_uuid',
			)
			.all(userId) as { track_uuid: string; played_at: number }[]

		return {
			version: USER_STATE_SNAPSHOT_VERSION,
			revision: getRevision(userId),
			playlists: playlists.map((row) => ({
				uuid: row.uuid,
				name: row.name,
				description: row.description,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			})),
			playlistEntries: entries.map((row) => ({
				playlistUuid: row.playlist_uuid,
				trackUuid: row.track_uuid,
				addedAt: row.added_at,
			})),
			history: history.map((row) => ({ trackUuid: row.track_uuid, playedAt: row.played_at })),
		}
	}

	const playlistExists = (userId: number, uuid: string): boolean =>
		db.prepare('SELECT 1 FROM playlists WHERE user_id = ? AND uuid = ?').get(userId, uuid) !==
		undefined

	const applyOne = (userId: number, action: UserStateAction): void => {
		switch (action.action) {
			case 'playlist-create': {
				try {
					db.prepare(
						'INSERT INTO playlists (user_id, uuid, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
					).run(
						userId,
						action.uuid,
						action.name,
						action.description ?? '',
						action.createdAt,
						action.updatedAt,
					)
				} catch (error) {
					if (isUniqueViolation(error)) {
						throw new UserStateActionError(
							`Invalid action: playlist ${action.uuid} already exists`,
						)
					}
					throw error
				}
				return
			}
			case 'playlist-update': {
				const changes = db
					.prepare(`
						UPDATE playlists SET
							name = COALESCE(?, name),
							description = COALESCE(?, description),
							updated_at = ?
						WHERE user_id = ? AND uuid = ?
					`)
					.run(
						action.name ?? null,
						action.description ?? null,
						action.updatedAt,
						userId,
						action.uuid,
					).changes
				if (changes === 0) {
					throw new UserStateActionError(
						`Invalid action: playlist ${action.uuid} does not exist`,
					)
				}
				return
			}
			case 'playlist-delete': {
				const changes = db
					.prepare('DELETE FROM playlists WHERE user_id = ? AND uuid = ?')
					.run(userId, action.uuid).changes
				if (changes === 0) {
					throw new UserStateActionError(
						`Invalid action: playlist ${action.uuid} does not exist`,
					)
				}
				db.prepare(
					'DELETE FROM playlist_entries WHERE user_id = ? AND playlist_uuid = ?',
				).run(userId, action.uuid)
				return
			}
			case 'playlist-entry-add': {
				if (
					action.playlistUuid !== FAVORITES_PLAYLIST_UUID &&
					!playlistExists(userId, action.playlistUuid)
				) {
					throw new UserStateActionError(
						`Invalid action: playlist ${action.playlistUuid} does not exist`,
					)
				}
				// Re-adding the same track refreshes its timestamp instead of failing
				db.prepare(`
					INSERT INTO playlist_entries (user_id, playlist_uuid, track_uuid, added_at)
					VALUES (?, ?, ?, ?)
					ON CONFLICT (user_id, playlist_uuid, track_uuid) DO UPDATE SET added_at = excluded.added_at
				`).run(userId, action.playlistUuid, action.trackUuid, action.addedAt)
				return
			}
			case 'playlist-entry-remove': {
				db.prepare(
					'DELETE FROM playlist_entries WHERE user_id = ? AND playlist_uuid = ? AND track_uuid = ?',
				).run(userId, action.playlistUuid, action.trackUuid)
				return
			}
			case 'favorite-set': {
				if (action.favorite) {
					db.prepare(`
						INSERT INTO playlist_entries (user_id, playlist_uuid, track_uuid, added_at)
						VALUES (?, ?, ?, ?)
						ON CONFLICT (user_id, playlist_uuid, track_uuid) DO NOTHING
					`).run(userId, FAVORITES_PLAYLIST_UUID, action.trackUuid, Date.now())
				} else {
					db.prepare(
						'DELETE FROM playlist_entries WHERE user_id = ? AND playlist_uuid = ? AND track_uuid = ?',
					).run(userId, FAVORITES_PLAYLIST_UUID, action.trackUuid)
				}
				return
			}
			case 'history-record': {
				db.prepare(`
					INSERT INTO history (user_id, track_uuid, played_at)
					VALUES (?, ?, ?)
					ON CONFLICT (user_id, track_uuid) DO UPDATE SET played_at = excluded.played_at
				`).run(userId, action.trackUuid, action.playedAt)
				// Keep only the 100 most recent records
				db.prepare(`
					DELETE FROM history
					WHERE user_id = ? AND track_uuid NOT IN (
						SELECT track_uuid FROM history WHERE user_id = ? ORDER BY played_at DESC, track_uuid LIMIT ?
					)
				`).run(userId, userId, HISTORY_LIMIT)
				return
			}
			case 'history-remove': {
				db.prepare('DELETE FROM history WHERE user_id = ? AND track_uuid = ?').run(
					userId,
					action.trackUuid,
				)
				return
			}
			case 'history-clear': {
				db.prepare('DELETE FROM history WHERE user_id = ?').run(userId)
				return
			}
		}
	}

	const applyActions = (
		userId: number,
		actionId: string,
		actions: UserStateAction[],
	): UserStateSnapshot => {
		runInTransaction(db, () => {
			const alreadyApplied = db
				.prepare('SELECT 1 FROM applied_actions WHERE user_id = ? AND action_id = ?')
				.get(userId, actionId)
			if (alreadyApplied !== undefined) {
				// Idempotent replay: same request id returns the current snapshot unchanged
				return
			}

			for (const action of actions) {
				applyOne(userId, action)
			}

			db.prepare(`
				INSERT INTO user_state_meta (user_id, revision) VALUES (?, 1)
				ON CONFLICT (user_id) DO UPDATE SET revision = revision + 1
			`).run(userId)
			db.prepare(
				'INSERT INTO applied_actions (user_id, action_id, applied_at) VALUES (?, ?, ?)',
			).run(userId, actionId, Date.now())
		})
		return getSnapshot(userId)
	}

	return { getSnapshot, applyActions }
}
