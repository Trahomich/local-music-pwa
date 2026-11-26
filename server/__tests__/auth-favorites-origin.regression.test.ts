// @vitest-environment node

/**
 * Regression tests for two review findings of task #15:
 * 1) `playlist-entry-remove` must not touch the favorites pseudo-playlist (400 INVALID_ACTION,
 *    the favorite entry stays) — favorites change only through `favorite-set`.
 * 2) The same-origin guard must compare the scheme as well as the host, honouring
 *    `x-forwarded-proto` only when `SNAE_TRUST_PROXY=true`.
 */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	FAVORITES_PLAYLIST_UUID,
	SESSION_COOKIE_NAME,
	USER_STATE_ACTIONS_PATH,
	USER_STATE_BASE_PATH,
	type UserStateSnapshot,
} from '../../src/lib/auth/api.ts'
import { createAuthMiddleware } from '../auth/middleware.ts'

const REGISTER_PATH = '/api/auth/register'
const PASSWORD = 'password123'

interface ErrorBody {
	error: { code: string; message: string }
}

describe('auth regressions: favorites remove and origin scheme', () => {
	let sandboxDirectory: string
	let server: Server | undefined
	let origin: string
	let cookie: string | undefined

	const startServer = async () => {
		const middleware = createAuthMiddleware({ dataDir: sandboxDirectory })
		server = createServer((req, res) => {
			void middleware(req, res, () => {
				res.writeHead(404)
				res.end('next')
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

	const postJson = (
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	): Promise<Response> =>
		fetch(`${origin}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(cookie === undefined ? {} : { cookie }),
				...headers,
			},
			body: JSON.stringify(body),
		})

	const expectError = async (response: Response, status: number, code: string) => {
		expect(response.status).toBe(status)
		const body = (await response.json()) as ErrorBody
		expect(body.error.code).toBe(code)
	}

	const getSnapshot = async (): Promise<UserStateSnapshot> => {
		const response = await fetch(`${origin}${USER_STATE_BASE_PATH}`, {
			headers: cookie === undefined ? {} : { cookie },
		})
		expect(response.status).toBe(200)
		return (await response.json()) as UserStateSnapshot
	}

	const register = async (username: string) => {
		const response = await postJson(REGISTER_PATH, { username, password: PASSWORD })
		expect(response.status).toBe(201)
		const setCookie = response.headers
			.getSetCookie()
			.find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`))
		expect(setCookie).toBeDefined()
		cookie = (setCookie ?? '').split(';')[0]
	}

	beforeEach(async () => {
		sandboxDirectory = await mkdtemp(join(tmpdir(), 'snae-auth-regression-'))
		cookie = undefined
	})

	afterEach(async () => {
		delete process.env.SNAE_TRUST_PROXY
		if (server?.listening) {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => {
					if (error) {
						reject(error)
					} else {
						resolve()
					}
				})
			})
		}
		server = undefined
		await rm(sandboxDirectory, { force: true, recursive: true })
	})

	it('rejects playlist-entry-remove for the favorites pseudo-playlist and keeps the entry', async () => {
		await startServer()
		await register('fav.user')

		const trackUuid = 'server:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
		const favorite = await postJson(USER_STATE_ACTIONS_PATH, {
			id: 'req-fav-1',
			action: { action: 'favorite-set', trackUuid, favorite: true },
		})
		expect(favorite.status).toBe(200)

		const remove = await postJson(USER_STATE_ACTIONS_PATH, {
			id: 'req-fav-2',
			action: {
				action: 'playlist-entry-remove',
				playlistUuid: FAVORITES_PLAYLIST_UUID,
				trackUuid,
			},
		})
		await expectError(remove, 400, 'INVALID_ACTION')

		const snapshot = await getSnapshot()
		expect(snapshot.revision).toBe(1)
		expect(snapshot.playlistEntries).toEqual([
			{ playlistUuid: FAVORITES_PLAYLIST_UUID, trackUuid, addedAt: expect.any(Number) },
		])
	})

	it('rejects a same-host origin with a mismatched scheme over plain HTTP', async () => {
		await startServer()

		const schemeMismatch = await postJson(
			REGISTER_PATH,
			{ username: 'scheme.user', password: PASSWORD },
			{ origin: origin.replace('http://', 'https://') },
		)
		await expectError(schemeMismatch, 403, 'ORIGIN_MISMATCH')

		const sameOrigin = await postJson(
			REGISTER_PATH,
			{ username: 'scheme.user', password: PASSWORD },
			{ origin },
		)
		expect(sameOrigin.status).toBe(201)
	})

	it('honours x-forwarded-proto only behind a trusted proxy', async () => {
		await startServer()

		// Without trust the forwarded header is ignored: the request is plain HTTP,
		// so an https origin is a scheme mismatch
		const untrusted = await postJson(
			REGISTER_PATH,
			{ username: 'proxy.user', password: PASSWORD },
			{ origin: origin.replace('http://', 'https://'), 'x-forwarded-proto': 'https' },
		)
		await expectError(untrusted, 403, 'ORIGIN_MISMATCH')

		process.env.SNAE_TRUST_PROXY = 'true'

		const forwardedHttps = await postJson(
			REGISTER_PATH,
			{ username: 'proxy.user', password: PASSWORD },
			{ origin: origin.replace('http://', 'https://'), 'x-forwarded-proto': 'https' },
		)
		expect(forwardedHttps.status).toBe(201)

		const forwardedHttpOrigin = await postJson(
			REGISTER_PATH,
			{ username: 'proxy.user2', password: PASSWORD },
			{ origin, 'x-forwarded-proto': 'https' },
		)
		await expectError(forwardedHttpOrigin, 403, 'ORIGIN_MISMATCH')
	})
})
