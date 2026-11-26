/**
 * Browser client of the per-user state HTTP API (CONTRACTS.md §9).
 *
 * Every call requires an authenticated session cookie; a `null` user id
 * (local-only/static mode) never reaches this module — callers gate on
 * `getCurrentUserId()` first. Failures are explicit: network problems,
 * non-JSON bodies and API errors all throw {@link UserStateRequestError},
 * so an operation is never reported as saved when the server did not
 * apply it.
 */

import {
	type AuthErrorCode,
	type AuthErrorResponse,
	USER_STATE_ACTIONS_PATH,
	USER_STATE_BASE_PATH,
	USER_STATE_SNAPSHOT_VERSION,
	type UserStateAction,
	type UserStateActionsRequest,
	type UserStateSnapshot,
} from '#lib/auth/api.ts'

export type UserStateRequestErrorCode = AuthErrorCode | 'NETWORK_ERROR' | 'HTTP_ERROR'

export class UserStateRequestError extends Error {
	readonly code: UserStateRequestErrorCode
	readonly httpStatus: number

	constructor(code: UserStateRequestErrorCode, httpStatus: number, message: string) {
		super(message)
		this.name = 'UserStateRequestError'
		this.code = code
		this.httpStatus = httpStatus
	}
}

const USER_STATE_REQUEST_TIMEOUT_MS = 10_000

const tryParseJson = async <T>(response: Response): Promise<T | null> => {
	try {
		return (await response.json()) as T
	} catch {
		return null
	}
}

const isUserStateSnapshot = (value: unknown): value is UserStateSnapshot => {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const snapshot = value as Partial<UserStateSnapshot>
	return (
		snapshot.version === USER_STATE_SNAPSHOT_VERSION &&
		typeof snapshot.revision === 'number' &&
		Number.isSafeInteger(snapshot.revision) &&
		Array.isArray(snapshot.playlists) &&
		Array.isArray(snapshot.playlistEntries) &&
		Array.isArray(snapshot.history)
	)
}

const errorFromResponse = async (response: Response): Promise<UserStateRequestError> => {
	let code: UserStateRequestErrorCode = response.status === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR'

	const body = await tryParseJson<Partial<AuthErrorResponse>>(response)
	if (body?.error?.code) {
		code = body.error.code
	}

	return new UserStateRequestError(
		code,
		response.status,
		`User state request failed with ${response.status}`,
	)
}

const requestSnapshot = async (input: string, init: RequestInit): Promise<UserStateSnapshot> => {
	let response: Response
	try {
		response = await fetch(input, {
			...init,
			headers: { Accept: 'application/json', ...init.headers },
			signal: AbortSignal.timeout(USER_STATE_REQUEST_TIMEOUT_MS),
		})
	} catch (cause) {
		throw new UserStateRequestError(
			'NETWORK_ERROR',
			0,
			cause instanceof Error ? cause.message : 'Network request failed',
		)
	}

	if (!response.ok) {
		throw await errorFromResponse(response)
	}

	const body = await tryParseJson<UserStateSnapshot>(response)
	if (body === null || !isUserStateSnapshot(body)) {
		throw new UserStateRequestError(
			'HTTP_ERROR',
			response.status,
			'Malformed user state response',
		)
	}

	return body
}

/** Full snapshot of the current user's playlists, entries and history. */
export const fetchUserStateSnapshot = (): Promise<UserStateSnapshot> =>
	requestSnapshot(USER_STATE_BASE_PATH, { method: 'GET' })

/**
 * Applies one idempotent action (or an atomic batch) under a single
 * client-generated request id and returns the full resulting snapshot.
 */
export const postUserStateActions = (
	actions: readonly [UserStateAction, ...UserStateAction[]],
	id: string = crypto.randomUUID(),
): Promise<UserStateSnapshot> => {
	const body: UserStateActionsRequest =
		actions.length === 1 && actions[0] !== undefined
			? { id, action: actions[0] }
			: { id, actions: [...actions] }

	return requestSnapshot(USER_STATE_ACTIONS_PATH, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}
