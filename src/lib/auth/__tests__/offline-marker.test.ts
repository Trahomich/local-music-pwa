// Контракт: CONTRACTS.md §12 — offline user marker `snae-offline-user` в
// localStorage: ровно {id, username} (никогда не пароль/токен); сетевой сбой
// или timeout bootstrap с валидным marker открывает ТОТ ЖЕ per-user профиль
// (status offline, getCurrentUserId = id marker); только явный JSON
// AUTH_REQUIRED и успешный logout очищают marker; static-hosting ответы
// (HTML, 404, 500, не-JSON 401) marker не трогают; успешный bootstrap и
// login/register перезаписывают marker (account switch); недоступный
// localStorage не ломает auth.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AuthClient = typeof import('#lib/auth/client.ts')

const MARKER_KEY = 'snae-offline-user'
const PASSWORD = 'Str0ng!Passw0rd#Xy'

const reloadSpy = vi.fn()
let client: AuthClient
let fetchMock: ReturnType<typeof vi.fn>

const jsonResponse = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

const htmlResponse = (status: number, html = '<!doctype html><html><body>app</body></html>') =>
	new Response(html, { status, headers: { 'Content-Type': 'text/html' } })

const readStoredMarker = (): unknown => {
	const raw = window.localStorage.getItem(MARKER_KEY)
	return raw === null ? null : JSON.parse(raw)
}

beforeEach(async () => {
	vi.resetModules()
	vi.stubEnv('MODE', 'production')
	reloadSpy.mockClear()

	window.localStorage.clear()

	fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	vi.stubGlobal('location', { reload: reloadSpy })

	client = await import('#lib/auth/client.ts')
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe('bootstrap с offline marker (§12)', () => {
	it('сетевой сбой с валидным marker → offline user из marker, тот же per-user namespace', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'offline', user: { id: 7, username: 'Alice' } })
		// Тот же id, что у authenticated: per-user БД открывается без сети.
		expect(client.getCurrentUserId()).toBe('7')
	})

	it('timeout запроса (AbortError) с marker → тот же offline user', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 3, username: 'Bob' }))
		fetchMock.mockRejectedValue(new DOMException('signal timed out', 'TimeoutError'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'offline', user: { id: 3, username: 'Bob' } })
		expect(client.getCurrentUserId()).toBe('3')
	})

	it('marker с лишними полями: offline user содержит ровно {id, username}, token не протекает', async () => {
		window.localStorage.setItem(
			MARKER_KEY,
			JSON.stringify({ id: 5, username: 'Carol', token: 'secret-jwt', password: PASSWORD }),
		)
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		const state = await client.bootstrapAuth()

		expect(state.status).toBe('offline')
		if (state.status !== 'offline') {
			throw new Error('expected offline state')
		}
		expect(Object.keys(state.user).sort()).toEqual(['id', 'username'])
		expect(JSON.stringify(state)).not.toContain('secret-jwt')
		expect(JSON.stringify(state)).not.toContain(PASSWORD)
	})

	it('битый JSON в marker при сбое сети → local-only, без падения', async () => {
		window.localStorage.setItem(MARKER_KEY, '{not-json')
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
		expect(client.getCurrentUserId()).toBeNull()
	})

	it('marker невалидной формы (id строка) при сбое сети → local-only', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 'seven', username: 'Alice' }))
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
	})

	it('без marker сетевой сбой → local-only (anonymous профиль, не offline)', async () => {
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
		expect(client.getCurrentUserId()).toBeNull()
	})
})

describe('очистка и перезапись marker (§12)', () => {
	it('401 с JSON AUTH_REQUIRED очищает marker', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockResolvedValue(
			jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'no session' } }),
		)

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'unauthenticated' })
		expect(window.localStorage.getItem(MARKER_KEY)).toBeNull()
	})

	it('401 без JSON (прокси/static) НЕ очищает marker — offline-профиль сохраняется', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockResolvedValue(htmlResponse(401, 'Unauthorized'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
		expect(readStoredMarker()).toEqual({ id: 7, username: 'Alice' })
	})

	it('200 с SPA fallback HTML НЕ очищает marker', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockResolvedValue(htmlResponse(200))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
		expect(readStoredMarker()).toEqual({ id: 7, username: 'Alice' })
	})

	it('500 НЕ очищает marker', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } }))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
		expect(readStoredMarker()).toEqual({ id: 7, username: 'Alice' })
	})

	it('успешный bootstrap перезаписывает marker (account switch A → B) ровно {id, username}', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 9, username: 'Bob' } }))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'authenticated', user: { id: 9, username: 'Bob' } })
		const stored = readStoredMarker()
		expect(stored).toEqual({ id: 9, username: 'Bob' })
		expect(Object.keys(stored as object).sort()).toEqual(['id', 'username'])
	})
})

describe('login/register/logout и marker (§12)', () => {
	it('login записывает marker ровно {id, username} — пароль не сохраняется', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 11, username: 'Dave' } }))

		await client.login('Dave', PASSWORD)

		const stored = readStoredMarker()
		expect(stored).toEqual({ id: 11, username: 'Dave' })
		expect(Object.keys(stored as object).sort()).toEqual(['id', 'username'])
		expect(window.localStorage.getItem(MARKER_KEY)).not.toContain(PASSWORD)
	})

	it('register записывает marker', async () => {
		fetchMock.mockResolvedValue(jsonResponse(201, { user: { id: 12, username: 'Erin' } }))

		await client.register('Erin', PASSWORD)

		expect(readStoredMarker()).toEqual({ id: 12, username: 'Erin' })
	})

	it('неудачный login (401) не записывает marker и не затирает существующий', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockResolvedValue(
			jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'bad pair' } }),
		)

		await expect(client.login('Alice', 'wrong-password')).rejects.toThrow()

		expect(readStoredMarker()).toEqual({ id: 7, username: 'Alice' })
	})

	it('успешный logout очищает marker', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

		await client.logout()

		expect(window.localStorage.getItem(MARKER_KEY)).toBeNull()
	})

	it('logout при сетевом сбое НЕ очищает marker (logout не завершён)', async () => {
		window.localStorage.setItem(MARKER_KEY, JSON.stringify({ id: 7, username: 'Alice' }))
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		await expect(client.logout()).rejects.toThrow()

		expect(readStoredMarker()).toEqual({ id: 7, username: 'Alice' })
	})

	it('недоступный localStorage (private mode) не ломает login', async () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('denied', 'SecurityError')
		})
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 13, username: 'Frank' } }))

		await client.login('Frank', PASSWORD)

		expect(client.getAuthState()).toEqual({
			status: 'authenticated',
			user: { id: 13, username: 'Frank' },
		})
		expect(reloadSpy).toHaveBeenCalledTimes(1)
	})
})
