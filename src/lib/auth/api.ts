/**
 * Isomorphic contract of the multiuser auth and per-user state HTTP API.
 *
 * Shared by the Node backend (`server/`), the browser client and tests.
 * Must stay free of Node/DOM dependencies.
 */

/** @public */
export const AUTH_BASE_PATH = '/api/auth'

/** @public */
export const USER_STATE_BASE_PATH = '/api/user-state'

/** @public */
export const USER_STATE_ACTIONS_PATH = `${USER_STATE_BASE_PATH}/actions`

/** Unauthenticated liveness endpoint used by Docker/Compose healthchecks. */
/** @public */
export const HEALTH_BASE_PATH = '/api/health'

/** Name of the session cookie set by the backend. */
/** @public */
export const SESSION_COOKIE_NAME = 'snae_session'

/** Lifetime of a server session and of its cookie, in seconds (30 days). */
/** @public */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** @public */
export const USERNAME_MIN_LENGTH = 3

/** @public */
export const USERNAME_MAX_LENGTH = 32

/** ASCII-only usernames: letters, digits, dot, underscore, dash. */
/** @public */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/

/** @public */
export const PASSWORD_MIN_LENGTH = 8

/** @public */
export const PASSWORD_MAX_LENGTH = 128

/** @public */
export const isValidUsername = (username: unknown): username is string =>
	typeof username === 'string' &&
	username.length >= USERNAME_MIN_LENGTH &&
	username.length <= USERNAME_MAX_LENGTH &&
	USERNAME_PATTERN.test(username)

/** @public */
export const isValidPassword = (password: unknown): password is string =>
	typeof password === 'string' &&
	password.length >= PASSWORD_MIN_LENGTH &&
	password.length <= PASSWORD_MAX_LENGTH

/**
 * Original case is preserved for display; uniqueness key is NFKC + lowercase,
 * so `User` and `user` cannot be registered as separate accounts.
 * @public
 */
export const normalizeUsernameKey = (username: string): string =>
	username.normalize('NFKC').toLowerCase()

/** @public */
export interface AuthUser {
	id: number
	username: string
}

/** Successful register/login/me response. */
/** @public */
export interface AuthResponse {
	user: AuthUser
}

/** @public */
export interface HealthResponse {
	status: 'ok'
}

/** @public */
export type AuthErrorCode =
	| 'AUTH_REQUIRED'
	| 'INVALID_CREDENTIALS'
	| 'USERNAME_TAKEN'
	| 'REGISTRATION_DISABLED'
	| 'RATE_LIMITED'
	| 'INVALID_ACTION'
	| 'INVALID_REQUEST'
	| 'ORIGIN_MISMATCH'
	| 'NOT_FOUND'
	| 'INTERNAL_ERROR'

/** @public */
export interface AuthErrorResponse {
	error: {
		code: AuthErrorCode
		message: string
	}
}

/** Wire identifier of the special favorites pseudo-playlist; it never appears in `playlists`. */
/** @public */
export const FAVORITES_PLAYLIST_UUID = 'favorites'

/** @public */
export const USER_STATE_SNAPSHOT_VERSION = 1

/** @public */
export interface UserStatePlaylist {
	uuid: string
	name: string
	description: string
	createdAt: number
	updatedAt: number
}

/** @public */
export interface UserStatePlaylistEntry {
	playlistUuid: string
	trackUuid: string
	addedAt: number
}

/** @public */
export interface UserStateHistoryEntry {
	trackUuid: string
	playedAt: number
}

/** @public */
export interface UserStateSnapshot {
	version: typeof USER_STATE_SNAPSHOT_VERSION
	revision: number
	playlists: UserStatePlaylist[]
	playlistEntries: UserStatePlaylistEntry[]
	/** At most 100 entries, one per trackUuid, most recently played first. */
	history: UserStateHistoryEntry[]
}

/**
 * One idempotent state mutation. Fields mirror the snapshot records.
 * `favorite-set` is the only way to change the favorites pseudo-playlist.
 */
/** @public */
export type UserStateAction =
	| {
			action: 'playlist-create'
			uuid: string
			name: string
			description?: string
			createdAt: number
			updatedAt: number
	  }
	| {
			action: 'playlist-update'
			uuid: string
			name?: string
			description?: string
			updatedAt: number
	  }
	| { action: 'playlist-delete'; uuid: string }
	| { action: 'playlist-entry-add'; playlistUuid: string; trackUuid: string; addedAt: number }
	| { action: 'playlist-entry-remove'; playlistUuid: string; trackUuid: string }
	| { action: 'favorite-set'; trackUuid: string; favorite: boolean }
	| { action: 'history-record'; trackUuid: string; playedAt: number }
	| { action: 'history-remove'; trackUuid: string }
	| { action: 'history-clear' }

/**
 * Body of `POST /api/user-state/actions`. A single `action` or an atomic batch `actions`,
 * applied in one transaction under one idempotency key `id` (a client-generated UUID).
 */
/** @public */
export type UserStateActionsRequest = { id: string } & (
	| { action: UserStateAction }
	| { actions: UserStateAction[] }
)
