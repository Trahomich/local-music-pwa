// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	type AuthErrorResponse,
	type AuthResponse,
	FAVORITES_PLAYLIST_UUID,
	SESSION_COOKIE_NAME,
	SESSION_MAX_AGE_SECONDS,
	type UserStateAction,
	type UserStateActionsRequest,
	type UserStateSnapshot,
} from '../../src/lib/auth/api.ts'
import { createAuthMiddleware } from '../auth/middleware.ts'

const HEALTH_PATH = '/api/health'
const REGISTER_PATH = '/api/auth/register'
const LOGIN_PATH = '/api/auth/login'
const LOGOUT_PATH = '/api/auth/logout'
const ME_PATH = '/api/auth/me'
const USER_STATE_PATH = '/api/user-state'
const USER_STATE_ACTIONS_PATH = '/api/user-state/actions'
const LIBRARY_STATUS_PATH = '/api/server-library/status'

const PASSWORD = 'Str0ng!Passw0rd'
const HEX_64_PATTERN = /^[0-9a-f]{64}$/
const ENV_KEYS = ['SNAE_ALLOW_REGISTRATION', 'SNAE_SECURE_COOKIES', 'SNAE_TRUST_PROXY'] as const

const parseSetCookiePair = (header: string): { name: string; value: string } => {
	const semicolon = header.indexOf(';')
	const pair = semicolon === -1 ? header : header.slice(0, semicolon)
	const equals = pair.indexOf('=')
	return { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim() }
}

const sessionTokenOf = (response: Response): string | undefined => {
	let token: string | undefined
	for (const header of response.headers.getSetCookie()) {
		const cookie = parseSetCookiePair(header)
		if (cookie.name === SESSION_COOKIE_NAME && cookie.value !== '') {
			token = cookie.value
		}
	}
	return token
}

/** Minimal cookie jar for the single session cookie. */
class SessionJar {
	private token: string | undefined

	capture(response: Response): void {
		const token = sessionTokenOf(response)
		if (token !== undefined) {
			this.token = token
		}
	}

	set(token: string | undefined): void {
		this.token = token
	}

	get current(): string | undefined {
		return this.token
	}

	headers(): Record<string, string> {
		return this.token === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${this.token}` }
	}
}

const trackUuid = (label: string): string =>
	`server:${createHash('sha256').update(label).digest('hex')}`

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('auth middleware and per-user state', () => {
	let sandbox: string
	let dataDir: string
	let server: Server | undefined
	let origin: string
	let nextCalls: string[]
	let clock: number
	const savedEnv: Record<string, string | undefined> = {}

	const advance = (ms: number): void => {
		clock += ms
	}

	const closeServer = async (): Promise<void> => {
		if (server?.listening) {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => (error ? reject(error) : resolve()))
			})
		}
		server = undefined
	}

	const createAuthServer = async (): Promise<void> => {
		const middleware = createAuthMiddleware({ dataDir, now: () => clock })
		server = createServer((req, res) => {
			void middleware(req, res, () => {
				nextCalls.push(req.url ?? '')
				res.writeHead(200, { 'content-type': 'text/plain' })
				res.end('NEXT')
			})
		})
		server.listen(0, '127.0.0.1')
		await once(server, 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') {
			throw new Error('Test server did not expose a TCP port')
		}
		origin = `http://127.0.0.1:${address.port}`
	}

	const requestRaw = (path: string, init?: RequestInit): Promise<Response> =>
		fetch(`${origin}${path}`, init)

	const postJson = async (
		path: string,
		body: unknown,
		jar?: SessionJar,
		headers: Record<string, string> = {},
	): Promise<Response> => {
		const response = await requestRaw(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...jar?.headers(), ...headers },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		})
		jar?.capture(response)
		return response
	}

	const getJson = async (
		path: string,
		jar?: SessionJar,
		headers: Record<string, string> = {},
	): Promise<Response> =>
		fetch(`${origin}${path}`, { headers: { ...jar?.headers(), ...headers } })

	const expectError = async (response: Response, status: number, code: string): Promise<void> => {
		expect(response.status).toBe(status)
		expect(response.headers.get('content-type')).toContain('application/json')
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = (await response.json()) as AuthErrorResponse
		expect(body.error.code).toBe(code)
		expect(body.error.message.length).toBeGreaterThan(0)
	}

	const registerUser = async (
		jar: SessionJar,
		username: string,
		password: string = PASSWORD,
	): Promise<{ id: number; username: string }> => {
		const response = await postJson(REGISTER_PATH, { username, password }, jar)
		expect(response.status).toBe(201)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = (await response.json()) as AuthResponse
		expect(sessionTokenOf(response)).toMatch(HEX_64_PATTERN)
		return body.user
	}

	const loginUser = async (
		jar: SessionJar,
		username: string,
		password: string = PASSWORD,
	): Promise<Response> => postJson(LOGIN_PATH, { username, password }, jar)

	const getSnapshot = async (jar: SessionJar): Promise<UserStateSnapshot> => {
		const response = await getJson(USER_STATE_PATH, jar)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		return (await response.json()) as UserStateSnapshot
	}

	const applyActions = async (
		jar: SessionJar,
		actionId: string,
		payload: UserStateAction | UserStateAction[],
	): Promise<UserStateSnapshot> => {
		const body: UserStateActionsRequest = Array.isArray(payload)
			? { id: actionId, actions: payload }
			: { id: actionId, action: payload }
		const response = await postJson(USER_STATE_ACTIONS_PATH, body, jar)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		return (await response.json()) as UserStateSnapshot
	}

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key]
			delete process.env[key]
		}
		sandbox = await mkdtemp(join(tmpdir(), 'snae-auth-test-'))
		dataDir = join(sandbox, 'data')
		server = undefined
		nextCalls = []
		clock = Date.now()
	})

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = savedEnv[key]
			}
		}
		await closeServer()
		await rm(sandbox, { force: true, recursive: true })
	})

	it('serves a public no-store health check without leaking configuration', async () => {
		await createAuthServer()

		const response = await requestRaw(HEALTH_PATH)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = (await response.json()) as Record<string, unknown>
		expect(Object.keys(body).sort()).toEqual(['status'])
		expect(body.status).toBe('ok')
		expect(JSON.stringify(body)).not.toContain(sandbox)
		expect(nextCalls).toHaveLength(0)
	})

	it('registers a user and sets a strict non-secure session cookie over plain HTTP', async () => {
		await createAuthServer()

		const jar = new SessionJar()
		const user = await registerUser(jar, 'First.User_1')
		expect(user.username).toBe('First.User_1')
		expect(Number.isInteger(user.id)).toBe(true)

		const setCookieHeaders = (
			await postJson(
				REGISTER_PATH,
				{ username: 'Second.User_1', password: PASSWORD },
				new SessionJar(),
			)
		).headers.getSetCookie()
		const sessionCookie = setCookieHeaders.find((header) =>
			header.startsWith(`${SESSION_COOKIE_NAME}=`),
		)
		expect(sessionCookie).toBeDefined()
		expect(sessionCookie ?? '').toContain('HttpOnly')
		expect(sessionCookie ?? '').toContain('SameSite=Strict')
		expect(sessionCookie ?? '').toContain('Path=/')
		expect(sessionCookie ?? '').toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`)
		// plain HTTP without trust proxy or SNAE_SECURE_COOKIES must not set Secure
		expect(sessionCookie ?? '').not.toContain('Secure')

		// session works immediately after register
		const me = await getJson(ME_PATH, jar)
		expect(me.status).toBe(200)
	})

	it.each([
		['ab', 'too short'],
		['a'.repeat(33), 'too long'],
		['has space', 'space'],
		['mixed/char', 'slash'],
		['пользователь', 'non-ascii'],
		['emoji😀user', 'emoji'],
		[' leadingspace', 'leading whitespace'],
	])('rejects invalid username %j (%s) with INVALID_CREDENTIALS', async (username) => {
		await createAuthServer()

		const response = await postJson(REGISTER_PATH, { username, password: PASSWORD })
		await expectError(response, 400, 'INVALID_CREDENTIALS')
	})

	it.each([
		['x'.repeat(7), 'too short'],
		['x'.repeat(129), 'too long'],
	])('rejects invalid password of length %s with INVALID_CREDENTIALS', async (password) => {
		await createAuthServer()

		const response = await postJson(REGISTER_PATH, { username: 'valid.name', password })
		await expectError(response, 400, 'INVALID_CREDENTIALS')
	})

	it('accepts usernames and passwords at the contract boundaries', async () => {
		await createAuthServer()

		for (const username of ['abc', 'z'.repeat(32)]) {
			const response = await postJson(REGISTER_PATH, { username, password: '12345678' })
			expect(response.status).toBe(201)
		}
		const maxPassword = 'p'.repeat(128)
		const response = await postJson(REGISTER_PATH, {
			username: 'max.pass',
			password: maxPassword,
		})
		expect(response.status).toBe(201)
	})

	it('keeps username uniqueness case-insensitive while preserving the original case', async () => {
		await createAuthServer()

		const jar = new SessionJar()
		const user = await registerUser(jar, 'Mixed.Case_1')
		expect(user.username).toBe('Mixed.Case_1')

		for (const duplicate of ['mixed.case_1', 'MIXED.CASE_1']) {
			const response = await postJson(REGISTER_PATH, {
				username: duplicate,
				password: PASSWORD,
			})
			await expectError(response, 409, 'USERNAME_TAKEN')
		}

		// login with a different case resolves to the same account
		const loginJar = new SessionJar()
		const login = await loginUser(loginJar, 'MIXED.CASE_1')
		expect(login.status).toBe(200)
		const me = (await (await getJson(ME_PATH, loginJar)).json()) as AuthResponse
		expect(me.user.id).toBe(user.id)
		expect(me.user.username).toBe('Mixed.Case_1')
	})

	it('returns identical errors for unknown users and wrong passwords', async () => {
		await createAuthServer()
		await registerUser(new SessionJar(), 'existing.user')

		const wrongPassword = await postJson(LOGIN_PATH, {
			username: 'existing.user',
			password: 'Wr0ng!Passw0rd',
		})
		const unknownUser = await postJson(LOGIN_PATH, {
			username: 'ghost.user',
			password: PASSWORD,
		})
		expect(wrongPassword.status).toBe(401)
		expect(unknownUser.status).toBe(401)
		// identical bodies prove the response does not reveal which usernames exist
		await expect(wrongPassword.json()).resolves.toEqual(await unknownUser.json())
	})

	it('rate limits failed logins per username with Retry-After', async () => {
		await createAuthServer()
		await registerUser(new SessionJar(), 'limited.user')
		await registerUser(new SessionJar(), 'other.user')

		for (let attempt = 0; attempt < 10; attempt += 1) {
			const response = await postJson(LOGIN_PATH, {
				username: 'limited.user',
				password: 'Wr0ng!Passw0rd',
			})
			expect(response.status).toBe(401)
		}

		const blocked = await postJson(LOGIN_PATH, {
			username: 'limited.user',
			password: 'Wr0ng!Passw0rd',
		})
		await expectError(blocked, 429, 'RATE_LIMITED')
		expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)

		// the limiter is keyed per username: other users from the same IP still get 401
		const other = await postJson(LOGIN_PATH, {
			username: 'other.user',
			password: 'Wr0ng!Passw0rd',
		})
		expect(other.status).toBe(401)

		// and registration stays open
		const register = await postJson(REGISTER_PATH, {
			username: 'third.user',
			password: PASSWORD,
		})
		expect(register.status).toBe(201)
	})

	it('clears the failed-login counter after a successful login', async () => {
		await createAuthServer()
		await registerUser(new SessionJar(), 'reset.user')

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const response = await postJson(LOGIN_PATH, {
				username: 'reset.user',
				password: 'Wr0ng!Passw0rd',
			})
			expect(response.status).toBe(401)
		}
		const success = await loginUser(new SessionJar(), 'reset.user')
		expect(success.status).toBe(200)

		// after the success the window was cleared: further failures are plain 401
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const response = await postJson(LOGIN_PATH, {
				username: 'reset.user',
				password: 'Wr0ng!Passw0rd',
			})
			expect(response.status).toBe(401)
		}
	})

	it.each([
		['over plain HTTP by default', {}, {}, false],
		['with SNAE_SECURE_COOKIES=true', { SNAE_SECURE_COOKIES: 'true' }, {}, true],
		[
			'behind a trusted https proxy',
			{ SNAE_TRUST_PROXY: 'true' },
			{ 'x-forwarded-proto': 'https' },
			true,
		],
		['behind an untrusted https proxy', {}, { 'x-forwarded-proto': 'https' }, false],
	])('sets the Secure cookie flag correctly %s', async (_title, env, headers, secure) => {
		for (const [key, value] of Object.entries(env)) {
			process.env[key] = value
		}
		await createAuthServer()

		const response = await postJson(
			REGISTER_PATH,
			{ username: 'cookie.user', password: PASSWORD },
			new SessionJar(),
			headers,
		)
		const sessionCookie = response.headers
			.getSetCookie()
			.find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`))
		expect(sessionCookie).toBeDefined()
		expect((sessionCookie ?? '').includes('Secure')).toBe(secure)
	})

	it('rejects cross-origin mutations but accepts same-origin and same-host requests', async () => {
		await createAuthServer()

		const crossOrigin = await postJson(
			REGISTER_PATH,
			{ username: 'cross.user', password: PASSWORD },
			undefined,
			{ origin: 'http://evil.example' },
		)
		await expectError(crossOrigin, 403, 'ORIGIN_MISMATCH')

		const sameOrigin = await postJson(
			REGISTER_PATH,
			{ username: 'same.user', password: PASSWORD },
			undefined,
			{ origin },
		)
		expect(sameOrigin.status).toBe(201)

		const noOrigin = await postJson(REGISTER_PATH, {
			username: 'no.origin',
			password: PASSWORD,
		})
		expect(noOrigin.status).toBe(201)
	})

	it('accepts only JSON mutation bodies', async () => {
		await createAuthServer()

		const plainText = await requestRaw(REGISTER_PATH, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: `{"username":"plain.user","password":"${PASSWORD}"}`,
		})
		await expectError(plainText, 400, 'INVALID_REQUEST')

		const malformed = await postJson(REGISTER_PATH, '{not json')
		await expectError(malformed, 400, 'INVALID_REQUEST')

		const oversized = await postJson(REGISTER_PATH, { username: 'x'.repeat(70 * 1024) })
		await expectError(oversized, 400, 'INVALID_REQUEST')
	})

	it('disables registration via SNAE_ALLOW_REGISTRATION without blocking login', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'early.user')

		// the flag is read at request time, so it can be flipped without a restart
		process.env.SNAE_ALLOW_REGISTRATION = 'false'

		const blocked = await postJson(REGISTER_PATH, { username: 'late.user', password: PASSWORD })
		await expectError(blocked, 403, 'REGISTRATION_DISABLED')

		const login = await loginUser(jar, 'early.user')
		expect(login.status).toBe(200)
		const me = await getJson(ME_PATH, jar)
		expect(me.status).toBe(200)
	})

	it('authenticates me and rejects missing or garbage session cookies', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		const user = await registerUser(jar, 'known.user')

		const anonymous = await getJson(ME_PATH)
		await expectError(anonymous, 401, 'AUTH_REQUIRED')

		const garbageJar = new SessionJar()
		garbageJar.set('deadbeef'.repeat(8))
		const garbage = await getJson(ME_PATH, garbageJar)
		await expectError(garbage, 401, 'AUTH_REQUIRED')

		const me = await getJson(ME_PATH, jar)
		expect(me.status).toBe(200)
		const body = (await me.json()) as AuthResponse
		expect(body.user).toEqual(user)
	})

	it('expires sessions after 30 days', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'patient.user')

		advance(31 * 24 * 60 * 60 * 1000)

		const expired = await getJson(ME_PATH, jar)
		await expectError(expired, 401, 'AUTH_REQUIRED')

		// re-login with the same credentials still works after expiry
		const freshJar = new SessionJar()
		const login = await loginUser(freshJar, 'patient.user')
		expect(login.status).toBe(200)
		const me = await getJson(ME_PATH, freshJar)
		expect(me.status).toBe(200)
	})

	it('logs out, invalidates the server session and clears the cookie', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'leaving.user')
		const token = jar.current
		if (token === undefined) {
			throw new Error('expected a session token after register')
		}

		const logout = await postJson(LOGOUT_PATH, {}, jar)
		expect(logout.status).toBe(204)
		expect(logout.headers.get('cache-control')).toBe('no-store')
		const clearCookie = logout.headers
			.getSetCookie()
			.find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`))
		expect(clearCookie ?? '').toContain('Max-Age=0')

		// the server session is gone even if the old cookie is replayed
		jar.set(token)
		const me = await getJson(ME_PATH, jar)
		await expectError(me, 401, 'AUTH_REQUIRED')

		// logout does not require a valid session
		const anonymousLogout = await postJson(LOGOUT_PATH, {})
		expect(anonymousLogout.status).toBe(204)

		// but it still enforces the JSON/Origin mutation contract
		const plainTextLogout = await requestRaw(LOGOUT_PATH, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: '{}',
		})
		await expectError(plainTextLogout, 400, 'INVALID_REQUEST')
	})

	it.each([
		['GET', '/api/server-library/status'],
		['GET', '/api/server-library/files'],
		['GET', '/api/server-library/file?path=song.mp3'],
		['GET', '/api/server-library/catalog'],
		['GET', `/api/server-library/artwork/${'ab'.repeat(32)}`],
		['POST', '/api/server-library/rescan'],
		['GET', '/api/user-state'],
		['POST', '/api/user-state/actions'],
	])('requires a session for %s %s (401, JSON, no redirect)', async (method, path) => {
		await createAuthServer()

		const response = await requestRaw(path, {
			method,
			headers: { 'content-type': 'application/json' },
			body: method === 'POST' ? '{}' : undefined,
		})
		await expectError(response, 401, 'AUTH_REQUIRED')
		expect(response.headers.get('location')).toBeNull()
		expect(nextCalls).toHaveLength(0)
	})

	it('lets sessions through the library guard and never guards static routes', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'guarded.user')

		const guarded = await getJson(LIBRARY_STATUS_PATH, jar)
		expect(guarded.status).toBe(200)
		expect(await guarded.text()).toBe('NEXT')
		expect(nextCalls).toEqual([LIBRARY_STATUS_PATH])

		const staticRoute = await requestRaw('/some/page')
		expect(staticRoute.status).toBe(200)
		expect(await staticRoute.text()).toBe('NEXT')
		expect(nextCalls).toEqual([LIBRARY_STATUS_PATH, '/some/page'])
	})

	it('handles unknown auth paths and unsupported methods', async () => {
		await createAuthServer()

		const unknownAuth = await getJson('/api/auth/unknown')
		await expectError(unknownAuth, 404, 'NOT_FOUND')

		const wrongMethod = await getJson(LOGIN_PATH)
		expect(wrongMethod.status).toBe(405)
		expect(wrongMethod.headers.get('allow')).toBe('POST')

		const jar = new SessionJar()
		await registerUser(jar, 'method.user')
		const unknownState = await getJson('/api/user-state/unknown', jar)
		await expectError(unknownState, 404, 'NOT_FOUND')
	})

	it('returns an empty snapshot for a fresh account', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'fresh.user')

		const snapshot = await getSnapshot(jar)
		expect(snapshot).toEqual({
			version: 1,
			revision: 0,
			playlists: [],
			playlistEntries: [],
			history: [],
		})
	})

	it('applies playlist and favorite actions with one revision bump per request', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'playlist.user')

		const playlistUuid = randomUUID()
		const track = trackUuid('playlist-track')
		const created = await applyActions(jar, randomUUID(), {
			action: 'playlist-create',
			uuid: playlistUuid,
			name: 'My List',
			description: 'first',
			createdAt: 1000,
			updatedAt: 2000,
		})
		expect(created.revision).toBe(1)
		expect(created.playlists).toEqual([
			{
				uuid: playlistUuid,
				name: 'My List',
				description: 'first',
				createdAt: 1000,
				updatedAt: 2000,
			},
		])

		const withEntry = await applyActions(jar, randomUUID(), {
			action: 'playlist-entry-add',
			playlistUuid,
			trackUuid: track,
			addedAt: 3000,
		})
		expect(withEntry.revision).toBe(2)
		expect(withEntry.playlistEntries).toEqual([
			{ playlistUuid, trackUuid: track, addedAt: 3000 },
		])

		const updated = await applyActions(jar, randomUUID(), {
			action: 'playlist-update',
			uuid: playlistUuid,
			name: 'Renamed',
			updatedAt: 4000,
		})
		expect(updated.revision).toBe(3)
		expect(updated.playlists[0]?.name).toBe('Renamed')
		expect(updated.playlists[0]?.updatedAt).toBe(4000)
		expect(updated.playlists[0]?.description).toBe('first')

		// favorites live only in playlistEntries under the reserved uuid
		const favorited = await applyActions(jar, randomUUID(), {
			action: 'favorite-set',
			trackUuid: track,
			favorite: true,
		})
		expect(favorited.revision).toBe(4)
		expect(favorited.playlists).toHaveLength(1)
		expect(favorited.playlistEntries).toContainEqual({
			playlistUuid: FAVORITES_PLAYLIST_UUID,
			trackUuid: track,
			addedAt: expect.any(Number),
		})

		const unfavorited = await applyActions(jar, randomUUID(), {
			action: 'favorite-set',
			trackUuid: track,
			favorite: false,
		})
		expect(unfavorited.revision).toBe(5)
		expect(unfavorited.playlistEntries).toHaveLength(1)

		const removedEntry = await applyActions(jar, randomUUID(), {
			action: 'playlist-entry-remove',
			playlistUuid,
			trackUuid: track,
		})
		expect(removedEntry.revision).toBe(6)
		expect(removedEntry.playlistEntries).toHaveLength(0)

		// deleting a playlist cascades to its entries
		const withCascade = await applyActions(jar, randomUUID(), {
			action: 'playlist-entry-add',
			playlistUuid,
			trackUuid: track,
			addedAt: 5000,
		})
		expect(withCascade.playlistEntries).toHaveLength(1)
		const deleted = await applyActions(jar, randomUUID(), {
			action: 'playlist-delete',
			uuid: playlistUuid,
		})
		expect(deleted.revision).toBe(8)
		expect(deleted.playlists).toHaveLength(0)
		expect(deleted.playlistEntries).toHaveLength(0)
	})

	it('keeps a single history entry per track and orders it most recent first', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'history.user')

		const first = trackUuid('history-first')
		const second = trackUuid('history-second')
		const recorded = await applyActions(jar, randomUUID(), {
			action: 'history-record',
			trackUuid: first,
			playedAt: 1000,
		})
		expect(recorded.revision).toBe(1)
		expect(recorded.history).toEqual([{ trackUuid: first, playedAt: 1000 }])

		const reRecorded = await applyActions(jar, randomUUID(), {
			action: 'history-record',
			trackUuid: first,
			playedAt: 2000,
		})
		expect(reRecorded.history).toHaveLength(1)
		expect(reRecorded.history).toEqual([{ trackUuid: first, playedAt: 2000 }])

		const extended = await applyActions(jar, randomUUID(), {
			action: 'history-record',
			trackUuid: second,
			playedAt: 3000,
		})
		expect(extended.history).toEqual([
			{ trackUuid: second, playedAt: 3000 },
			{ trackUuid: first, playedAt: 2000 },
		])

		const removed = await applyActions(jar, randomUUID(), {
			action: 'history-remove',
			trackUuid: first,
		})
		expect(removed.history).toEqual([{ trackUuid: second, playedAt: 3000 }])

		const cleared = await applyActions(jar, randomUUID(), { action: 'history-clear' })
		expect(cleared.history).toHaveLength(0)
	})

	it('caps history at the 100 most recent records', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'prolific.user')

		const actions: UserStateAction[] = []
		for (let index = 0; index < 105; index += 1) {
			actions.push({
				action: 'history-record',
				trackUuid: trackUuid(`history-${index}`),
				playedAt: 1000 + index,
			})
		}
		const batchBody: UserStateActionsRequest = { id: 'replay-batch', actions }
		const first = await postJson(USER_STATE_ACTIONS_PATH, batchBody, jar)
		expect(first.status).toBe(200)
		const snapshot = (await first.json()) as UserStateSnapshot
		expect(snapshot.revision).toBe(1)
		expect(snapshot.history).toHaveLength(100)
		expect(snapshot.history[0]).toEqual({
			trackUuid: trackUuid('history-104'),
			playedAt: 1104,
		})
		expect(snapshot.history.some((entry) => entry.trackUuid === trackUuid('history-0'))).toBe(
			false,
		)

		// replaying the same request id must not apply the 105 records a second time
		const replay = await postJson(USER_STATE_ACTIONS_PATH, batchBody, jar)
		expect(replay.status).toBe(200)
		const replayed = (await replay.json()) as UserStateSnapshot
		expect(replayed.revision).toBe(1)
		expect(replayed.history).toHaveLength(100)
	})

	it('applies a batch of actions atomically in one transaction', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'atomic.user')

		const playlistUuid = randomUUID()
		const track = trackUuid('atomic-track')
		const failingBatch: UserStateAction[] = [
			{
				action: 'playlist-create',
				uuid: playlistUuid,
				name: 'Partial',
				createdAt: 1000,
				updatedAt: 1000,
			},
			{ action: 'playlist-update', uuid: randomUUID(), name: 'Missing', updatedAt: 2000 },
		]
		const failed = await postJson(
			USER_STATE_ACTIONS_PATH,
			{ id: randomUUID(), actions: failingBatch },
			jar,
		)
		await expectError(failed, 400, 'INVALID_ACTION')

		// nothing was applied: no partial playlist, revision untouched
		const snapshot = await getSnapshot(jar)
		expect(snapshot.revision).toBe(0)
		expect(snapshot.playlists).toHaveLength(0)

		const goodBatch: UserStateAction[] = [
			{
				action: 'playlist-create',
				uuid: playlistUuid,
				name: 'Whole',
				createdAt: 1000,
				updatedAt: 1000,
			},
			{ action: 'playlist-entry-add', playlistUuid, trackUuid: track, addedAt: 2000 },
			{ action: 'favorite-set', trackUuid: track, favorite: true },
			{ action: 'history-record', trackUuid: track, playedAt: 3000 },
		]
		const applied = await applyActions(jar, randomUUID(), goodBatch)
		expect(applied.revision).toBe(1)
		expect(applied.playlists).toHaveLength(1)
		expect(applied.playlistEntries).toHaveLength(2)
		expect(applied.history).toHaveLength(1)
	})

	it('replays an already applied request id without re-applying it', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'idempotent.user')

		const playlistUuid = randomUUID()
		const body: UserStateActionsRequest = {
			id: 'fixed-request-id',
			action: {
				action: 'playlist-create',
				uuid: playlistUuid,
				name: 'Once',
				createdAt: 1000,
				updatedAt: 1000,
			},
		}
		const first = await postJson(USER_STATE_ACTIONS_PATH, body, jar)
		expect(first.status).toBe(200)
		const firstSnapshot = (await first.json()) as UserStateSnapshot
		expect(firstSnapshot.revision).toBe(1)

		// the identical replay succeeds and changes nothing (no USERNAME-style conflict)
		const replay = await postJson(USER_STATE_ACTIONS_PATH, body, jar)
		expect(replay.status).toBe(200)
		const replaySnapshot = (await replay.json()) as UserStateSnapshot
		expect(replaySnapshot).toEqual(firstSnapshot)
		expect(replaySnapshot.playlists).toHaveLength(1)

		// the same action under a NEW id is a genuine duplicate and must fail
		const duplicate = await postJson(
			USER_STATE_ACTIONS_PATH,
			{ ...body, id: 'another-request-id' },
			jar,
		)
		await expectError(duplicate, 400, 'INVALID_ACTION')
	})

	it('rejects unknown actions and misuse of the favorites pseudo-playlist', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'strict.user')

		const unknown = await postJson(
			USER_STATE_ACTIONS_PATH,
			{ id: randomUUID(), action: { action: 'nuke-everything' } },
			jar,
		)
		await expectError(unknown, 400, 'INVALID_ACTION')

		const missingId = await postJson(
			USER_STATE_ACTIONS_PATH,
			{ action: { action: 'history-clear' } },
			jar,
		)
		await expectError(missingId, 400, 'INVALID_ACTION')

		const emptyBatch = await postJson(
			USER_STATE_ACTIONS_PATH,
			{ id: randomUUID(), actions: [] },
			jar,
		)
		await expectError(emptyBatch, 400, 'INVALID_ACTION')

		const reservedCreate = await postJson(
			USER_STATE_ACTIONS_PATH,
			{
				id: randomUUID(),
				action: {
					action: 'playlist-create',
					uuid: FAVORITES_PLAYLIST_UUID,
					name: 'Fake',
					createdAt: 1000,
					updatedAt: 1000,
				},
			},
			jar,
		)
		await expectError(reservedCreate, 400, 'INVALID_ACTION')

		const reservedEntry = await postJson(
			USER_STATE_ACTIONS_PATH,
			{
				id: randomUUID(),
				action: {
					action: 'playlist-entry-add',
					playlistUuid: FAVORITES_PLAYLIST_UUID,
					trackUuid: trackUuid('reserved'),
					addedAt: 1000,
				},
			},
			jar,
		)
		await expectError(reservedEntry, 400, 'INVALID_ACTION')

		const snapshot = await getSnapshot(jar)
		expect(snapshot.revision).toBe(0)
		expect(snapshot.playlists).toHaveLength(0)
		expect(snapshot.playlistEntries).toHaveLength(0)
	})

	it('accepts an empty-string description (UI form default) for create and update', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'emptydesc.user')

		// The NewPlaylistDialog form sends description: '' when the field is
		// left empty — this must create the playlist, not INVALID_ACTION (§9).
		const playlistUuid = randomUUID()
		const created = await applyActions(jar, randomUUID(), {
			action: 'playlist-create',
			uuid: playlistUuid,
			name: 'No Description',
			description: '',
			createdAt: 1000,
			updatedAt: 1000,
		})
		expect(created.playlists).toEqual([
			{
				uuid: playlistUuid,
				name: 'No Description',
				description: '',
				createdAt: 1000,
				updatedAt: 1000,
			},
		])

		// Clearing a description through update with '' works the same way.
		const withDescription = await applyActions(jar, randomUUID(), {
			action: 'playlist-update',
			uuid: playlistUuid,
			description: 'x',
			updatedAt: 2000,
		})
		expect(withDescription.playlists[0]?.description).toBe('x')
		const cleared = await applyActions(jar, randomUUID(), {
			action: 'playlist-update',
			uuid: playlistUuid,
			description: '',
			updatedAt: 3000,
		})
		expect(cleared.playlists[0]?.description).toBe('')

		// Non-string descriptions are still rejected.
		const bad = await postJson(
			USER_STATE_ACTIONS_PATH,
			{
				id: randomUUID(),
				action: {
					action: 'playlist-create',
					uuid: randomUUID(),
					name: 'Bad',
					description: 42,
					createdAt: 1000,
					updatedAt: 1000,
				},
			},
			jar,
		)
		await expectError(bad, 400, 'INVALID_ACTION')
	})

	it('strictly isolates state between two accounts, even with shared uuids and request ids', async () => {
		await createAuthServer()
		const jarA = new SessionJar()
		const jarB = new SessionJar()
		const userA = await registerUser(jarA, 'user.a')
		const userB = await registerUser(jarB, 'user.b')
		expect(userA.id).not.toBe(userB.id)

		const sharedPlaylistUuid = randomUUID()
		const sharedRequestId = randomUUID()
		const trackA = trackUuid('track-of-a')
		const trackB = trackUuid('track-of-b')

		const actionsOfA: UserStateAction[] = [
			{
				action: 'playlist-create',
				uuid: sharedPlaylistUuid,
				name: 'A List',
				createdAt: 1000,
				updatedAt: 1000,
			},
			{
				action: 'playlist-entry-add',
				playlistUuid: sharedPlaylistUuid,
				trackUuid: trackA,
				addedAt: 2000,
			},
			{ action: 'favorite-set', trackUuid: trackA, favorite: true },
			{ action: 'history-record', trackUuid: trackA, playedAt: 3000 },
		]
		const snapshotA = await applyActions(jarA, sharedRequestId, actionsOfA)
		expect(snapshotA.revision).toBe(1)
		expect(snapshotA.playlists.map((playlist) => playlist.uuid)).toEqual([sharedPlaylistUuid])
		expect(snapshotA.playlistEntries.map((entry) => entry.trackUuid)).toEqual(
			expect.arrayContaining([trackA]),
		)
		expect(snapshotA.history).toEqual([{ trackUuid: trackA, playedAt: 3000 }])

		// B applies the very same playlist uuid and request id with its own data
		const actionsOfB: UserStateAction[] = [
			{
				action: 'playlist-create',
				uuid: sharedPlaylistUuid,
				name: 'B List',
				createdAt: 5000,
				updatedAt: 5000,
			},
			{
				action: 'playlist-entry-add',
				playlistUuid: sharedPlaylistUuid,
				trackUuid: trackB,
				addedAt: 6000,
			},
			{ action: 'favorite-set', trackUuid: trackB, favorite: true },
			{ action: 'history-record', trackUuid: trackB, playedAt: 7000 },
		]
		const snapshotB = await applyActions(jarB, sharedRequestId, actionsOfB)
		expect(snapshotB.revision).toBe(1)
		expect(snapshotB.playlists).toEqual([
			{
				uuid: sharedPlaylistUuid,
				name: 'B List',
				description: '',
				createdAt: 5000,
				updatedAt: 5000,
			},
		])
		expect(snapshotB.playlistEntries.map((entry) => entry.trackUuid)).toEqual(
			expect.arrayContaining([trackB]),
		)
		expect(snapshotB.history).toEqual([{ trackUuid: trackB, playedAt: 7000 }])

		// A is untouched by everything B did
		const snapshotAAfter = await getSnapshot(jarA)
		expect(snapshotAAfter).toEqual(snapshotA)
		expect(JSON.stringify(snapshotAAfter)).not.toContain(trackB)
		expect(JSON.stringify(snapshotB)).not.toContain(trackA)
	})

	it('persists users, sessions and state across a middleware restart', async () => {
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'persistent.user')
		const track = trackUuid('persistent-track')
		const before = await applyActions(jar, randomUUID(), {
			action: 'favorite-set',
			trackUuid: track,
			favorite: true,
		})
		expect(before.revision).toBe(1)

		await closeServer()
		await createAuthServer()

		// the old cookie is still valid because sessions live in auth.sqlite
		const me = await getJson(ME_PATH, jar)
		expect(me.status).toBe(200)

		const after = await getSnapshot(jar)
		expect(after).toEqual(before)

		// a brand new login still works too
		const freshJar = new SessionJar()
		const login = await loginUser(freshJar, 'persistent.user')
		expect(login.status).toBe(200)
	})

	it('stores no plaintext password or session token in auth.sqlite', async () => {
		const secretPassword = 'P@ssw0rd-S3cret-42!'
		await createAuthServer()
		const jar = new SessionJar()
		await registerUser(jar, 'vault.user', secretPassword)
		const token = jar.current
		if (token === undefined) {
			throw new Error('expected a session token after register')
		}
		await loginUser(new SessionJar(), 'vault.user', secretPassword)

		const dbPath = join(dataDir, 'auth.sqlite')
		const dbFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((path) =>
			existsSync(path),
		)
		expect(dbFiles.length).toBeGreaterThan(0)
		const contents = await Promise.all(dbFiles.map((path) => readFile(path)))

		const passwordBuffer = Buffer.from(secretPassword, 'utf8')
		const tokenBuffer = Buffer.from(token, 'utf8')
		const tokenHashHex = sha256Hex(token)
		for (const content of contents) {
			expect(content.includes(passwordBuffer)).toBe(false)
			expect(content.includes(tokenBuffer)).toBe(false)
		}
		// the scrypt password hash and the hashed session token ARE persisted
		expect(contents.some((content) => content.includes('scrypt:'))).toBe(true)
		expect(contents.some((content) => content.toString('utf8').includes(tokenHashHex))).toBe(
			true,
		)
	})
})
