// Контракт: CONTRACTS.md §8–9 — auth frontend: bootstrap до child DB; static
// hosting (HTML/404/сбой сети) сохраняет legacy local-only режим; только явный
// JSON AUTH_REQUIRED включает auth gate; login/register/logout меняют профиль
// через закрытие БД (change handlers) и reload; getCurrentUserId — синхронный
// seam без новых запросов; ошибки API маппятся в стабильные коды; пароль не
// сохраняется и не логируется; RU/EN сообщения auth UI существуют.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	isValidPassword,
	isValidUsername,
	normalizeUsernameKey,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	USERNAME_MAX_LENGTH,
	USERNAME_MIN_LENGTH,
} from '#lib/auth/api.ts'
import enMessages from '../../../../messages/en.json'
import ruMessages from '../../../../messages/ru.json'

type AuthClient = typeof import('#lib/auth/client.ts')

const reloadSpy = vi.fn()
const consoleSpies: ReturnType<typeof vi.spyOn>[] = []

let client: AuthClient
let fetchMock: ReturnType<typeof vi.fn>

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})

const htmlResponse = (status: number, html = '<!doctype html><html><body>app</body></html>') =>
	new Response(html, { status, headers: { 'Content-Type': 'text/html' } })

beforeEach(async () => {
	vi.resetModules()
	reloadSpy.mockClear()

	fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	vi.stubGlobal('location', { reload: reloadSpy })
	consoleSpies.length = 0
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}))
	}

	client = await import('#lib/auth/client.ts')
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	for (const spy of consoleSpies) {
		spy.mockRestore()
	}
})

describe('bootstrapAuth (§9: bootstrap до child DB)', () => {
	it('в test/SSR-режиме не делает ни одного запроса и остаётся local-only', async () => {
		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
		expect(client.getCurrentUserId()).toBeNull()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('кэширует результат: повторные вызовы не делают новых запросов', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 42, username: 'User' } }))

		const first = await client.bootstrapAuth()
		const second = await client.bootstrapAuth()

		expect(first).toEqual(second)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/auth/me')
	})

	it('200 с валидным JSON user → authenticated, getCurrentUserId отдаёт строковый id', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 42, username: 'User' } }))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'authenticated', user: { id: 42, username: 'User' } })
		// Seam для sync: синхронно, без нового запроса, числовой id строкой.
		expect(client.getCurrentUserId()).toBe('42')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('401 с JSON AUTH_REQUIRED → unauthenticated (auth gate)', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(
			jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'no session' } }),
		)

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'unauthenticated' })
		expect(client.getCurrentUserId()).toBeNull()
	})

	it('static hosting: 401 без JSON AUTH_REQUIRED (прокси/static) → local-only, не gate', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(htmlResponse(401, 'Unauthorized'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
	})

	it('static hosting: 200 с SPA fallback HTML → local-only', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(htmlResponse(200))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
	})

	it('static hosting: 404 → local-only', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(htmlResponse(404, 'Not Found'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
	})

	it('200 с malformed JSON (нет валидного user) → local-only', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 'not-a-number' } }))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
	})

	it('сетевой сбой → local-only (приложение работает без backend)', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
	})

	it('500 → local-only', async () => {
		vi.stubEnv('MODE', 'production')
		fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } }))

		const state = await client.bootstrapAuth()

		expect(state).toEqual({ status: 'local-only' })
	})
})

describe('login/register/logout (§9)', () => {
	const PASSWORD = 'Str0ng!Passw0rd#Xy'

	it('login: POST JSON, состояние authenticated, handlers до reload, пароль нигде не сохранён', async () => {
		const order: string[] = []
		client.registerAuthChangeHandler(() => {
			order.push('change-handler')
		})
		reloadSpy.mockImplementation(() => order.push('reload'))
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 7, username: 'User' } }))

		await client.login('User', PASSWORD)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('/api/auth/login')
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
		expect((init.headers as Record<string, string>).Accept).toBe('application/json')
		expect(JSON.parse(String(init.body))).toEqual({ username: 'User', password: PASSWORD })

		expect(client.getAuthState()).toEqual({
			status: 'authenticated',
			user: { id: 7, username: 'User' },
		})
		expect(client.getCurrentUserId()).toBe('7')

		// Профиль переключается через закрытие БД (handlers) и полный reload.
		expect(order).toEqual(['change-handler', 'reload'])

		// Пароль не попадает ни в storage, ни в логи.
		expect(globalThis.localStorage.length).toBe(0)
		expect(globalThis.sessionStorage.length).toBe(0)
		const logged = consoleSpies
			.flatMap((spy) => spy.mock.calls)
			.map((args) => args.map(String).join(' '))
			.join('\n')
		expect(logged).not.toContain(PASSWORD)
	})

	it('register: 201 → authenticated + reload', async () => {
		fetchMock.mockResolvedValue(jsonResponse(201, { user: { id: 9, username: 'New.User' } }))

		await client.register('New.User', PASSWORD)

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('/api/auth/register')
		expect(JSON.parse(String(init.body))).toEqual({ username: 'New.User', password: PASSWORD })
		expect(client.getCurrentUserId()).toBe('9')
		expect(reloadSpy).toHaveBeenCalledTimes(1)
	})

	it('logout: POST {} → unauthenticated + reload', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(200, { user: { id: 7, username: 'User' } }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }))

		await client.login('User', PASSWORD)
		reloadSpy.mockClear()

		await client.logout()

		const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
		expect(url).toBe('/api/auth/logout')
		expect(JSON.parse(String(init.body))).toEqual({})
		expect(client.getAuthState()).toEqual({ status: 'unauthenticated' })
		expect(client.getCurrentUserId()).toBeNull()
		expect(reloadSpy).toHaveBeenCalledTimes(1)
	})

	it('неверная пара: 401 → AuthRequestError INVALID_CREDENTIALS, состояние не меняется', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'invalid' } }),
		)

		const error = await client.login('User', 'wrong-password-1').catch((e: unknown) => e)

		expect(error).toBeInstanceOf(client.AuthRequestError)
		expect((error as InstanceType<typeof client.AuthRequestError>).code).toBe(
			'INVALID_CREDENTIALS',
		)
		expect((error as InstanceType<typeof client.AuthRequestError>).httpStatus).toBe(401)
		// Неуспешный login не переключает профиль и не перезагружает страницу.
		expect(client.getAuthState()).toEqual({ status: 'local-only' })
		expect(reloadSpy).not.toHaveBeenCalled()
	})

	it('401 без JSON-тела (нештатный backend) → стабильный код INVALID_CREDENTIALS', async () => {
		fetchMock.mockResolvedValue(htmlResponse(401, 'Unauthorized'))

		const error = await client.login('User', 'wrong-password-1').catch((e: unknown) => e)

		expect(error).toBeInstanceOf(client.AuthRequestError)
		expect((error as InstanceType<typeof client.AuthRequestError>).code).toBe(
			'INVALID_CREDENTIALS',
		)
	})

	it('register: 409 → USERNAME_TAKEN, 403 → REGISTRATION_DISABLED', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(409, { error: { code: 'USERNAME_TAKEN', message: 'taken' } }),
		)
		const taken = await client.register('User', PASSWORD).catch((e: unknown) => e)
		expect((taken as InstanceType<typeof client.AuthRequestError>).code).toBe('USERNAME_TAKEN')

		fetchMock.mockResolvedValueOnce(
			jsonResponse(403, { error: { code: 'REGISTRATION_DISABLED', message: 'off' } }),
		)
		const disabled = await client.register('User', PASSWORD).catch((e: unknown) => e)
		expect((disabled as InstanceType<typeof client.AuthRequestError>).code).toBe(
			'REGISTRATION_DISABLED',
		)
	})

	it('429 → RATE_LIMITED с retryAfterSeconds из Retry-After; без заголовка → null', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				429,
				{ error: { code: 'RATE_LIMITED', message: 'slow down' } },
				{
					'Retry-After': '17',
				},
			),
		)
		const limited = await client.login('User', PASSWORD).catch((e: unknown) => e)
		expect((limited as InstanceType<typeof client.AuthRequestError>).code).toBe('RATE_LIMITED')
		expect((limited as InstanceType<typeof client.AuthRequestError>).retryAfterSeconds).toBe(17)

		fetchMock.mockResolvedValueOnce(
			jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }),
		)
		const noHeader = await client.login('User', PASSWORD).catch((e: unknown) => e)
		expect(
			(noHeader as InstanceType<typeof client.AuthRequestError>).retryAfterSeconds,
		).toBeNull()
	})

	it('сетевой сбой → NETWORK_ERROR с httpStatus 0', async () => {
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))

		const error = await client.login('User', PASSWORD).catch((e: unknown) => e)

		expect(error).toBeInstanceOf(client.AuthRequestError)
		expect((error as InstanceType<typeof client.AuthRequestError>).code).toBe('NETWORK_ERROR')
		expect((error as InstanceType<typeof client.AuthRequestError>).httpStatus).toBe(0)
	})

	it('200 с malformed user → HTTP_ERROR', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { user: null }))

		const error = await client.login('User', PASSWORD).catch((e: unknown) => e)

		expect(error).toBeInstanceOf(client.AuthRequestError)
		expect((error as InstanceType<typeof client.AuthRequestError>).code).toBe('HTTP_ERROR')
	})

	it('unregister change handler: после отписки handler не вызывается', async () => {
		const handler = vi.fn()
		const unregister = client.registerAuthChangeHandler(handler)
		unregister()
		fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 1, username: 'Aaa' } }))

		await client.login('Aaa', PASSWORD)

		expect(handler).not.toHaveBeenCalled()
		expect(reloadSpy).toHaveBeenCalledTimes(1)
	})
})

describe('валидация username/password (§9)', () => {
	it('username: границы длины 3–32 и ASCII pattern [A-Za-z0-9._-]', () => {
		expect(isValidUsername('ab')).toBe(false)
		expect(isValidUsername('a'.repeat(USERNAME_MIN_LENGTH))).toBe(true)
		expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH))).toBe(true)
		expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false)

		expect(isValidUsername('User.Name_1-x')).toBe(true)
		expect(isValidUsername('user name')).toBe(false)
		expect(isValidUsername('пользователь')).toBe(false)
		expect(isValidUsername('user@example')).toBe(false)
		expect(isValidUsername('')).toBe(false)

		expect(isValidUsername(123)).toBe(false)
		expect(isValidUsername(null)).toBe(false)
		expect(isValidUsername(undefined)).toBe(false)
	})

	it('password: границы длины 8–128', () => {
		expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false)
		expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(true)
		expect(isValidPassword('a'.repeat(PASSWORD_MAX_LENGTH))).toBe(true)
		expect(isValidPassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe(false)
		expect(isValidPassword('')).toBe(false)
		expect(isValidPassword(12_345_678)).toBe(false)
		expect(isValidPassword(null)).toBe(false)
	})

	it('уникальность case-insensitive: NFKC + lower ключ одинаков для регистров и fullwidth', () => {
		expect(normalizeUsernameKey('User')).toBe(normalizeUsernameKey('user'))
		expect(normalizeUsernameKey('USER')).toBe(normalizeUsernameKey('user'))
		expect(normalizeUsernameKey('Ｕｓｅｒ')).toBe(normalizeUsernameKey('user'))
		expect(normalizeUsernameKey('User.Name')).toBe('user.name')
	})
})

describe('auth UI messages (§8–9: RU/EN)', () => {
	const AUTH_KEYS = [
		'authSignIn',
		'authCreateAccount',
		'authUsername',
		'authUsernameHint',
		'authPassword',
		'authPasswordHint',
		'authGateDescription',
		'authErrorInvalidCredentials',
		'authErrorUsernameTaken',
		'authErrorRegistrationDisabled',
		'authErrorRateLimited',
		'authErrorRateLimitedRetry',
		'authErrorNetwork',
		'authErrorUnexpected',
		'authAccount',
		'authLogout',
		'authSignedInAs',
	] as const

	it('все auth-ключи существуют и непусты в ru и en', () => {
		for (const key of AUTH_KEYS) {
			expect(ruMessages[key], `ru:${key}`).toBeTypeOf('string')
			expect(ruMessages[key].length, `ru:${key} пуст`).toBeGreaterThan(0)
			expect(enMessages[key], `en:${key}`).toBeTypeOf('string')
			expect(enMessages[key].length, `en:${key} пуст`).toBeGreaterThan(0)
		}
	})

	it('authErrorRateLimitedRetry содержит плейсхолдер {seconds} в обеих локалях', () => {
		expect(ruMessages.authErrorRateLimitedRetry).toContain('{seconds}')
		expect(enMessages.authErrorRateLimitedRetry).toContain('{seconds}')
	})

	it('ru и en сообщения различаются (реальный перевод, не копия)', () => {
		expect(ruMessages.authSignIn).not.toBe(enMessages.authSignIn)
		expect(ruMessages.authErrorInvalidCredentials).not.toBe(
			enMessages.authErrorInvalidCredentials,
		)
	})
})
