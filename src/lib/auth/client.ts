/**
 * Browser auth client (CONTRACTS.md §9).
 *
 * The auth state is resolved once per page load via {@link bootstrapAuth}
 * before any IndexedDB database is opened: the IndexedDB layer awaits the
 * bootstrap and picks its database name from {@link getCurrentUserId}.
 * A profile switch (login/register/logout) closes open databases through
 * {@link registerAuthChangeHandler} and always ends with a full page
 * reload, so no singleton, reactive cache or in-flight request can expose
 * the previous profile's data.
 *
 * Static hosting without a backend keeps working: when the auth API is
 * absent (HTML 404, SPA fallback, network failure) the client stays in
 * the `local-only` mode and the app behaves exactly as before.
 */

import {
	AUTH_BASE_PATH,
	type AuthErrorCode,
	type AuthErrorResponse,
	type AuthResponse,
	type AuthUser,
} from './api.ts'

export type AuthState =
	| { status: 'authenticated'; user: AuthUser }
	/** Auth backend is present but there is no valid session: show the auth gate. */
	| { status: 'unauthenticated' }
	/** No auth backend (static hosting): the previous local-only mode. */
	| { status: 'local-only' }

export type AuthRequestErrorCode = AuthErrorCode | 'NETWORK_ERROR' | 'HTTP_ERROR'

export class AuthRequestError extends Error {
	readonly code: AuthRequestErrorCode
	readonly httpStatus: number
	/** Value of the `Retry-After` header (seconds) for `RATE_LIMITED` responses. */
	readonly retryAfterSeconds: number | null

	constructor(
		code: AuthRequestErrorCode,
		httpStatus: number,
		message: string,
		retryAfterSeconds: number | null = null,
	) {
		super(message)
		this.name = 'AuthRequestError'
		this.code = code
		this.httpStatus = httpStatus
		this.retryAfterSeconds = retryAfterSeconds
	}
}

const AUTH_REQUEST_TIMEOUT_MS = 10_000

let authState: AuthState = { status: 'local-only' }
let bootstrapPromise: Promise<AuthState> | null = null

const isAuthUser = (value: unknown): value is AuthUser => {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const user = value as Partial<AuthUser>
	return (
		typeof user.id === 'number' &&
		Number.isSafeInteger(user.id) &&
		typeof user.username === 'string'
	)
}

const tryParseJson = async <T>(response: Response): Promise<T | null> => {
	try {
		return (await response.json()) as T
	} catch {
		return null
	}
}

const parseAuthMeResponse = async (response: Response): Promise<AuthState> => {
	if (response.status === 401) {
		// Gate only on an explicit JSON AUTH_REQUIRED from our backend; any
		// other 401 (proxy, static host) keeps the app in local-only mode.
		const body = await tryParseJson<AuthErrorResponse>(response)
		return body?.error?.code === 'AUTH_REQUIRED'
			? { status: 'unauthenticated' }
			: { status: 'local-only' }
	}

	if (!response.ok) {
		return { status: 'local-only' }
	}

	// A static host answers unknown paths with its SPA fallback HTML, so a
	// 200 alone proves nothing — only a well-formed JSON body does.
	const body = await tryParseJson<AuthResponse>(response)
	if (body !== null && isAuthUser(body.user)) {
		return { status: 'authenticated', user: body.user }
	}

	return { status: 'local-only' }
}

const fetchAuthMe = async (): Promise<AuthState> => {
	let response: Response
	try {
		response = await fetch(`${AUTH_BASE_PATH}/me`, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
		})
	} catch {
		return { status: 'local-only' }
	}

	return parseAuthMeResponse(response)
}

/**
 * Resolves the auth state once and caches it for the rest of the page
 * lifetime. Every IndexedDB access awaits this before opening a database,
 * which guarantees that child loaders never touch a database before the
 * profile namespace is known.
 */
export const bootstrapAuth = (): Promise<AuthState> => {
	// Server-side rendering never talks to the auth API, and unit tests run
	// without a backend: both keep the state set by login/register/logout
	// (or the initial local-only).
	if (import.meta.env.SSR || import.meta.env.MODE === 'test') {
		return Promise.resolve(authState)
	}

	if (bootstrapPromise === null) {
		bootstrapPromise = fetchAuthMe().then((state) => {
			authState = state
			return state
		})
	}

	return bootstrapPromise
}

/** Synchronous snapshot of the already resolved auth state. */
export const getAuthState = (): AuthState => authState

/**
 * Seam for the user-state sync (§9): synchronously returns the user id of
 * the finished bootstrap without any new network request, or `null` in the
 * local-only/unauthenticated mode. The numeric API id is stringified so
 * the same value works as an IndexedDB namespace and as a wire id.
 */
export const getCurrentUserId = (): string | null =>
	authState.status === 'authenticated' ? String(authState.user.id) : null

type AuthChangeHandler = () => void | Promise<void>
const changeHandlers = new Set<AuthChangeHandler>()

/**
 * Registers a callback invoked before the page reloads into a new profile
 * namespace. The database layer uses it to close open connections.
 */
export const registerAuthChangeHandler = (handler: AuthChangeHandler): (() => void) => {
	changeHandlers.add(handler)

	return () => {
		changeHandlers.delete(handler)
	}
}

const applySessionChange = async (nextState: AuthState): Promise<void> => {
	authState = nextState

	for (const handler of changeHandlers) {
		await handler()
	}

	globalThis.location.reload()
}

const parseRetryAfterSeconds = (response: Response): number | null => {
	const header = response.headers.get('Retry-After')
	if (header === null) {
		return null
	}

	const seconds = Number.parseInt(header, 10)
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

const errorFromResponse = async (response: Response): Promise<AuthRequestError> => {
	// The backend always sends a JSON error body; when it is missing we
	// still want a stable code, so 401 maps to INVALID_CREDENTIALS.
	let code: AuthRequestErrorCode = response.status === 401 ? 'INVALID_CREDENTIALS' : 'HTTP_ERROR'

	const body = await tryParseJson<Partial<AuthErrorResponse>>(response)
	if (body?.error?.code) {
		code = body.error.code
	}

	return new AuthRequestError(
		code,
		response.status,
		`Auth request failed with ${response.status}`,
		parseRetryAfterSeconds(response),
	)
}

const postCredentials = async (
	endpoint: 'login' | 'register',
	username: string,
	password: string,
): Promise<AuthUser> => {
	let response: Response
	try {
		response = await fetch(`${AUTH_BASE_PATH}/${endpoint}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({ username, password }),
			signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
		})
	} catch (cause) {
		throw new AuthRequestError(
			'NETWORK_ERROR',
			0,
			cause instanceof Error ? cause.message : 'Network request failed',
		)
	}

	if (!response.ok) {
		throw await errorFromResponse(response)
	}

	const body = await tryParseJson<AuthResponse>(response)
	if (body === null || !isAuthUser(body.user)) {
		throw new AuthRequestError('HTTP_ERROR', response.status, 'Malformed auth response')
	}

	return body.user
}

/**
 * Signs in and reloads the page into the account's profile namespace.
 * The password is only sent to the API and never stored or logged.
 */
export const login = async (username: string, password: string): Promise<void> => {
	const user = await postCredentials('login', username, password)
	await applySessionChange({ status: 'authenticated', user })
}

/** Creates an account, signs in and reloads like {@link login}. */
export const register = async (username: string, password: string): Promise<void> => {
	const user = await postCredentials('register', username, password)
	await applySessionChange({ status: 'authenticated', user })
}

/** Signs out and reloads the page into the unauthenticated state. */
export const logout = async (): Promise<void> => {
	let response: Response
	try {
		response = await fetch(`${AUTH_BASE_PATH}/logout`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: '{}',
			signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
		})
	} catch (cause) {
		throw new AuthRequestError(
			'NETWORK_ERROR',
			0,
			cause instanceof Error ? cause.message : 'Network request failed',
		)
	}

	if (!response.ok) {
		throw await errorFromResponse(response)
	}

	await applySessionChange({ status: 'unauthenticated' })
}
