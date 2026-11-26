import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import {
	AUTH_BASE_PATH,
	type AuthErrorCode,
	type AuthErrorResponse,
	type AuthResponse,
	HEALTH_BASE_PATH,
	type HealthResponse,
	isValidPassword,
	isValidUsername,
	normalizeUsernameKey,
	SESSION_COOKIE_NAME,
	SESSION_MAX_AGE_SECONDS,
	USER_STATE_ACTIONS_PATH,
	USER_STATE_BASE_PATH,
	type UserStateAction,
	type UserStateActionsRequest,
} from '../../src/lib/auth/api.ts'
import {
	createUserStateStore,
	parseUserStateAction,
	UserStateActionError,
} from '../user-state/store.ts'
import { checkPassword, createAuthDb, hashSessionToken } from './db.ts'

type NextFunction = (error?: unknown) => void

const SERVER_LIBRARY_BASE_PATH = '/api/server-library'
const SERVER_LIBRARY_GUARD_PATHS = [SERVER_LIBRARY_BASE_PATH]

const JSON_BODY_LIMIT = 64 * 1024
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10
const LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000

export interface AuthMiddlewareOptions {
	/** Directory holding `auth.sqlite`. Defaults to `DATA_DIR` env or `./.data`. */
	dataDir?: string
	/** Clock injection for tests. Defaults to `Date.now`. */
	now?: () => number
}

/** Malformed/oversized JSON body or aborted request. */
class InvalidBodyError extends Error {}

const sendJson = (res: ServerResponse, statusCode: number, body: unknown): void => {
	const payload = JSON.stringify(body)
	res.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Length': Buffer.byteLength(payload),
	})
	res.end(payload)
}

const sendError = (
	res: ServerResponse,
	statusCode: number,
	code: AuthErrorCode,
	message: string,
): void => {
	const body: AuthErrorResponse = { error: { code, message } }
	sendJson(res, statusCode, body)
}

const sendMethodNotAllowed = (res: ServerResponse, allow: string): void => {
	res.writeHead(405, { Allow: allow, 'Cache-Control': 'no-store' })
	res.end()
}

const parseCookies = (header: string | undefined): Record<string, string> => {
	const cookies: Record<string, string> = {}
	if (header === undefined) {
		return cookies
	}
	for (const part of header.split(';')) {
		const index = part.indexOf('=')
		if (index === -1) {
			continue
		}
		cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim()
	}
	return cookies
}

/** Scheme the client used, honouring `x-forwarded-proto` only behind a trusted proxy. */
const getRequestScheme = (req: IncomingMessage): 'http' | 'https' => {
	if ((req.socket as TLSSocket).encrypted === true) {
		return 'https'
	}
	if (process.env.SNAE_TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] === 'https') {
		return 'https'
	}
	return 'http'
}

/** Same-origin guard: a present `Origin` header must match the request host and scheme. */
const isSameOrigin = (req: IncomingMessage): boolean => {
	const origin = req.headers.origin
	if (origin === undefined) {
		return true
	}
	try {
		const originUrl = new URL(origin)
		return (
			originUrl.host === req.headers.host &&
			originUrl.protocol === `${getRequestScheme(req)}:`
		)
	} catch {
		return false
	}
}

const isJsonContentType = (req: IncomingMessage): boolean => {
	const contentType = req.headers['content-type']
	return (
		typeof contentType === 'string' &&
		(contentType === 'application/json' || contentType.startsWith('application/json;'))
	)
}

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
	const chunks: Buffer[] = []
	let size = 0
	try {
		for await (const chunk of req) {
			const buffer = chunk as Buffer
			size += buffer.length
			if (size > JSON_BODY_LIMIT) {
				throw new InvalidBodyError('Request body is too large')
			}
			chunks.push(buffer)
		}
	} catch (error) {
		if (error instanceof InvalidBodyError) {
			throw error
		}
		throw new InvalidBodyError('Request body could not be read')
	}

	const text = Buffer.concat(chunks).toString('utf8')
	if (text === '') {
		return undefined
	}
	try {
		return JSON.parse(text) as unknown
	} catch {
		throw new InvalidBodyError('Request body is not valid JSON')
	}
}

const isSecureRequest = (req: IncomingMessage): boolean =>
	process.env.SNAE_SECURE_COOKIES === 'true' || getRequestScheme(req) === 'https'

const buildSessionCookie = (req: IncomingMessage, token: string, maxAgeSeconds: number): string => {
	const parts = [
		`${SESSION_COOKIE_NAME}=${token}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		`Max-Age=${maxAgeSeconds}`,
	]
	if (isSecureRequest(req)) {
		parts.push('Secure')
	}
	return parts.join('; ')
}

interface LoginAttempts {
	count: number
	windowStart: number
}

/**
 * In-memory limiter of failed logins per IP + username (10 failures per 10 minutes).
 * Successful logins clear the counter; the limiter never blocks them.
 */
class LoginRateLimiter {
	private readonly attempts = new Map<string, LoginAttempts>()

	check(key: string, now: number): number | undefined {
		const entry = this.attempts.get(key)
		if (entry === undefined || now - entry.windowStart >= LOGIN_RATE_LIMIT_WINDOW_MS) {
			return undefined
		}
		if (entry.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
			return Math.ceil((entry.windowStart + LOGIN_RATE_LIMIT_WINDOW_MS - now) / 1000)
		}
		return undefined
	}

	recordFailure(key: string, now: number): void {
		const entry = this.attempts.get(key)
		if (entry === undefined || now - entry.windowStart >= LOGIN_RATE_LIMIT_WINDOW_MS) {
			this.attempts.set(key, { count: 1, windowStart: now })
			return
		}
		entry.count += 1
	}

	clear(key: string): void {
		this.attempts.delete(key)
	}
}

const isRequestPath = (pathname: string, basePath: string): boolean =>
	pathname === basePath || pathname.startsWith(`${basePath}/`)

/**
 * Connect-style middleware owning the auth and per-user state API.
 * Handles `/api/health`, `/api/auth/*` and `/api/user-state*`; requires a valid
 * session for `/api/server-library/*` before delegating to the library middleware
 * through `next()`; everything else passes through untouched.
 * @public
 */
export const createAuthMiddleware = (options: AuthMiddlewareOptions = {}) => {
	const now = options.now ?? (() => Date.now())
	const dataDir = options.dataDir ?? process.env.DATA_DIR ?? './.data'
	const authDb = createAuthDb(dataDir)
	const userStateStore = createUserStateStore(authDb.db)
	const rateLimiter = new LoginRateLimiter()
	let lastSessionCleanup = now()

	const clientAddress = (req: IncomingMessage): string => req.socket.remoteAddress ?? 'unknown'

	const cleanupSessionsIfDue = (): void => {
		const current = now()
		if (current - lastSessionCleanup >= SESSION_CLEANUP_INTERVAL_MS) {
			lastSessionCleanup = current
			authDb.deleteExpiredSessions(current)
		}
	}

	const getSessionUser = (req: IncomingMessage): { id: number; username: string } | undefined => {
		cleanupSessionsIfDue()
		const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
		if (token === undefined || token === '') {
			return undefined
		}
		const user = authDb.findSessionUser(hashSessionToken(token), now())
		return user === undefined ? undefined : { id: user.id, username: user.username }
	}

	/** Reads and validates a mutation body; sends the error response and returns `undefined` on failure. */
	const readMutationBody = async (
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<unknown> => {
		if (!isSameOrigin(req)) {
			sendError(res, 403, 'ORIGIN_MISMATCH', 'Cross-origin mutation requests are not allowed')
			return undefined
		}
		if (!isJsonContentType(req)) {
			sendError(res, 400, 'INVALID_REQUEST', 'Expected a JSON request body')
			return undefined
		}
		try {
			return await readJsonBody(req)
		} catch (error) {
			if (error instanceof InvalidBodyError) {
				sendError(res, 400, 'INVALID_REQUEST', error.message)
				return undefined
			}
			throw error
		}
	}

	const setSessionCookie = (req: IncomingMessage, res: ServerResponse, token: string): void => {
		res.setHeader('Set-Cookie', buildSessionCookie(req, token, SESSION_MAX_AGE_SECONDS))
	}

	const clearSessionCookie = (req: IncomingMessage, res: ServerResponse): void => {
		res.setHeader('Set-Cookie', buildSessionCookie(req, '', 0))
	}

	const handleRegister = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (process.env.SNAE_ALLOW_REGISTRATION === 'false') {
			sendError(res, 403, 'REGISTRATION_DISABLED', 'Registration is disabled')
			return
		}

		const body = await readMutationBody(req, res)
		if (body === undefined) {
			return
		}
		const credentials =
			typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
		if (!(isValidUsername(credentials.username) && isValidPassword(credentials.password))) {
			sendError(res, 400, 'INVALID_CREDENTIALS', 'Invalid username or password')
			return
		}

		const user = authDb.createUser(credentials.username, credentials.password)
		if (user === 'taken') {
			sendError(res, 409, 'USERNAME_TAKEN', 'This username is already taken')
			return
		}

		const session = authDb.createSession(user.id, now())
		setSessionCookie(req, res, session.token)
		const response: AuthResponse = { user: { id: user.id, username: user.username } }
		sendJson(res, 201, response)
	}

	const handleLogin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const body = await readMutationBody(req, res)
		if (body === undefined) {
			return
		}
		const credentials =
			typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
		const username = isValidUsername(credentials.username) ? credentials.username : ''
		const password = typeof credentials.password === 'string' ? credentials.password : ''
		const rateLimitKey = `${clientAddress(req)}|${normalizeUsernameKey(username || 'unknown')}`

		const retryAfterSeconds = rateLimiter.check(rateLimitKey, now())
		if (retryAfterSeconds !== undefined) {
			res.setHeader('Retry-After', String(Math.max(retryAfterSeconds, 1)))
			sendError(res, 429, 'RATE_LIMITED', 'Too many failed login attempts')
			return
		}

		// Unknown usernames and wrong passwords produce the identical response
		const user =
			username === ''
				? undefined
				: authDb.findUserByUsernameKey(normalizeUsernameKey(username))
		if (
			user === undefined ||
			!isValidPassword(password) ||
			!checkPassword(password, user.passwordHash)
		) {
			rateLimiter.recordFailure(rateLimitKey, now())
			sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid username or password')
			return
		}

		rateLimiter.clear(rateLimitKey)
		const session = authDb.createSession(user.id, now())
		setSessionCookie(req, res, session.token)
		const response: AuthResponse = { user: { id: user.id, username: user.username } }
		sendJson(res, 200, response)
	}

	const handleLogout = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const body = await readMutationBody(req, res)
		if (body === undefined) {
			return
		}
		const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
		if (token !== undefined && token !== '') {
			authDb.deleteSession(hashSessionToken(token))
		}
		clearSessionCookie(req, res)
		res.writeHead(204, { 'Cache-Control': 'no-store' })
		res.end()
	}

	const handleMe = (req: IncomingMessage, res: ServerResponse): void => {
		const user = getSessionUser(req)
		if (user === undefined) {
			sendError(res, 401, 'AUTH_REQUIRED', 'A valid session is required')
			return
		}
		const response: AuthResponse = { user }
		sendJson(res, 200, response)
	}

	const handleUserStateActions = async (
		req: IncomingMessage,
		res: ServerResponse,
		user: { id: number },
	): Promise<void> => {
		const body = await readMutationBody(req, res)
		if (body === undefined) {
			return
		}

		let actionId: string
		let actions: UserStateAction[]
		try {
			const request = body as UserStateActionsRequest
			if (
				typeof request !== 'object' ||
				request === null ||
				typeof request.id !== 'string' ||
				request.id === ''
			) {
				throw new UserStateActionError('Request must contain a non-empty string id')
			}
			actionId = request.id
			const rawActions =
				'actions' in request
					? request.actions
					: 'action' in request
						? [request.action]
						: undefined
			if (!Array.isArray(rawActions) || rawActions.length === 0) {
				throw new UserStateActionError(
					'Request must contain an action or a non-empty actions array',
				)
			}
			actions = rawActions.map((raw) => parseUserStateAction(raw))
		} catch (error) {
			if (error instanceof UserStateActionError) {
				sendError(res, 400, 'INVALID_ACTION', error.message)
				return
			}
			throw error
		}

		try {
			const snapshot = userStateStore.applyActions(user.id, actionId, actions)
			sendJson(res, 200, snapshot)
		} catch (error) {
			if (error instanceof UserStateActionError) {
				sendError(res, 400, 'INVALID_ACTION', error.message)
				return
			}
			throw error
		}
	}

	return async (req: IncomingMessage, res: ServerResponse, next: NextFunction): Promise<void> => {
		const requestUrl = new URL(req.url ?? '/', 'http://localhost')
		const pathname = requestUrl.pathname

		try {
			if (pathname === HEALTH_BASE_PATH) {
				if (req.method === 'GET' || req.method === 'HEAD') {
					const response: HealthResponse = { status: 'ok' }
					sendJson(res, 200, response)
					return
				}
				sendMethodNotAllowed(res, 'GET, HEAD')
				return
			}

			if (isRequestPath(pathname, AUTH_BASE_PATH)) {
				switch (pathname) {
					case `${AUTH_BASE_PATH}/register`:
						if (req.method !== 'POST') {
							sendMethodNotAllowed(res, 'POST')
							return
						}
						await handleRegister(req, res)
						return
					case `${AUTH_BASE_PATH}/login`:
						if (req.method !== 'POST') {
							sendMethodNotAllowed(res, 'POST')
							return
						}
						await handleLogin(req, res)
						return
					case `${AUTH_BASE_PATH}/logout`:
						if (req.method !== 'POST') {
							sendMethodNotAllowed(res, 'POST')
							return
						}
						await handleLogout(req, res)
						return
					case `${AUTH_BASE_PATH}/me`:
						if (req.method !== 'GET' && req.method !== 'HEAD') {
							sendMethodNotAllowed(res, 'GET, HEAD')
							return
						}
						handleMe(req, res)
						return
					default:
						sendError(res, 404, 'NOT_FOUND', 'Not found')
						return
				}
			}

			if (isRequestPath(pathname, USER_STATE_BASE_PATH)) {
				const user = getSessionUser(req)
				if (user === undefined) {
					sendError(res, 401, 'AUTH_REQUIRED', 'A valid session is required')
					return
				}
				if (pathname === USER_STATE_ACTIONS_PATH) {
					if (req.method !== 'POST') {
						sendMethodNotAllowed(res, 'POST')
						return
					}
					await handleUserStateActions(req, res, user)
					return
				}
				if (pathname === USER_STATE_BASE_PATH) {
					if (req.method !== 'GET' && req.method !== 'HEAD') {
						sendMethodNotAllowed(res, 'GET, HEAD')
						return
					}
					sendJson(res, 200, userStateStore.getSnapshot(user.id))
					return
				}
				sendError(res, 404, 'NOT_FOUND', 'Not found')
				return
			}

			if (SERVER_LIBRARY_GUARD_PATHS.some((basePath) => isRequestPath(pathname, basePath))) {
				const user = getSessionUser(req)
				if (user === undefined) {
					sendError(res, 401, 'AUTH_REQUIRED', 'A valid session is required')
					return
				}
				next()
				return
			}

			next()
		} catch (error) {
			console.error('[auth] Unexpected error:', error)
			if (res.headersSent) {
				res.destroy()
				return
			}
			sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
		}
	}
}
