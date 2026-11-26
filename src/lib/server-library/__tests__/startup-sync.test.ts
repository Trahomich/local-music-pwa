// Контракт: CONTRACTS.md §13 — автоматическая startup-синхронизация серверной
// библиотеки. Независимые проверки #43 к реализации #42 (автор тестов не
// трогает startup.ts и server/**): после готового auth startup один раз за
// page lifetime дёргает GET /api/server-library/status; enabled=false/offline
// не делают import/rescan; offline откладывает ОДИН retry до события online;
// 401/503/network сохраняют cached tracks, показывают ошибку без retry loop;
// отсутствует SERVER_DIRECTORY_ID → importServerDirectory(), есть →
// rescanServerDirectory(); local-only/static ничего не запускает; новый
// page lifetime/другой профиль повторяет запуск; повторный вызов — no-op.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '#lib/db/database.ts'
import { clearDatabaseStores, expectToBeDefined } from '#lib/helpers/test-helpers.ts'
import { type Directory, SERVER_DIRECTORY_ID } from '#lib/library/types.ts'
import type { ServerLibraryScanStatus } from '#lib/server-library/client.ts'

const mocks = vi.hoisted(() => ({
	userId: '1' as string | null,
	directoryActions: {
		importServerDirectory: vi.fn(async () => {}),
		rescanServerDirectory: vi.fn(async () => {}),
	},
	lockCalls: [] as string[],
	snackbar: Object.assign(vi.fn(), {
		unexpectedError: vi.fn(),
		dismiss: vi.fn(),
	}),
}))

vi.mock('#lib/auth/client.ts', () => ({
	bootstrapAuth: async () =>
		mocks.userId === null
			? { status: 'local-only' }
			: {
					status: 'authenticated',
					user: { id: Number(mocks.userId), username: `user${mocks.userId}` },
				},
	getCurrentUserId: () => mocks.userId,
	registerAuthChangeHandler: () => () => {},
}))

vi.mock('#lib/library/scan-actions/directories.ts', () => mocks.directoryActions)

vi.mock('#lib/db/lock-database.ts', () => ({
	lockDatabase: <T>(action: () => Promise<T>): Promise<T> => {
		mocks.lockCalls.push('lock')
		return action()
	},
	isDatabaseOperationPending: () => false,
}))

vi.mock('#lib/components/snackbar/snackbar.ts', () => ({
	snackbar: mocks.snackbar,
}))

import { installServerLibraryMock } from './server-library-mock.ts'

const STATUS_READY: ServerLibraryScanStatus = {
	enabled: true,
	state: 'ready',
	current: 0,
	total: 0,
}

// Реалистичный cached track в IndexedDB: startup ничего не должен стирать.
// Замечания: соединение НЕ закрываем — getDatabase() кэширует его в модуле;
// PK store 'tracks' числовой (autoIncrement), поэтому get идёт по ключу put.
let cachedTrackKey: number | undefined
const addCachedTrack = async (): Promise<void> => {
	const db = await getDatabase()
	cachedTrackKey = (await db.put('tracks', {
		uuid: 'cached-track-uuid-0001',
		directory: SERVER_DIRECTORY_ID,
		artwork: null,
		file: {
			kind: 'server',
			fileName: 'music/cached.mp3',
			size: 10,
			lastModified: 1_764_057_600_000,
		},
		data: { name: 'Cached', album: 'Cached Album', artists: ['Cached Artist'] },
	} as never)) as number
}

const putServerDirectory = async (): Promise<void> => {
	const db = await getDatabase()
	await db.put('directories', { id: SERVER_DIRECTORY_ID, kind: 'server' } as Directory)
}

const expectCachedTrackIntact = async (): Promise<void> => {
	expectToBeDefined(cachedTrackKey)
	const db = await getDatabase()
	const track = await db.get('tracks', cachedTrackKey)
	expectToBeDefined(track)
}

const stubStatusError = (status: number): ReturnType<typeof vi.fn> => {
	const fetchMock = vi.fn((input: unknown) => {
		const url =
			typeof input === 'string'
				? new URL(input, 'http://server-library.test')
				: new URL((input as Request).url, 'http://server-library.test')
		if (url.pathname === '/api/server-library/status') {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						error: {
							code: status === 401 ? 'AUTH_REQUIRED' : 'DIRECTORY_UNAVAILABLE',
							message: 'mock error',
						},
					}),
					{ status, headers: { 'content-type': 'application/json; charset=utf-8' } },
				),
			)
		}
		return Promise.resolve(new Response('not found', { status: 404 }))
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

// Свежий модульный guard на каждый тест (page lifetime = JS-сессия модуля).
const importStartup = async () => {
	vi.resetModules()
	return await import('#lib/server-library/startup.ts')
}

const waitFor = async (check: () => void, timeoutMs = 3000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			check()
			return
		} catch (error) {
			lastError = error
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
	}
	throw lastError
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('startup sync серверной библиотеки (CONTRACTS.md §13, #43)', () => {
	let originalOnLine: PropertyDescriptor | undefined

	beforeEach(async () => {
		mocks.userId = '1'
		mocks.lockCalls = []
		vi.clearAllMocks()
		await clearDatabaseStores()
		originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')
	})

	afterEach(async () => {
		vi.unstubAllGlobals()
		if (originalOnLine) {
			Object.defineProperty(window.navigator, 'onLine', originalOnLine)
		} else {
			delete (window.navigator as unknown as Record<string, unknown>).onLine
		}
		await clearDatabaseStores()
	})

	it('local-only/static: ни одного сетевого запроса, import/rescan не вызываются', async () => {
		mocks.userId = null
		const { installServerLibraryMock: install } = await import('./server-library-mock.ts')
		const { requests } = install()
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await settle(200)

		expect(requests).toHaveLength(0)
		expect(mocks.directoryActions.importServerDirectory).not.toHaveBeenCalled()
		expect(mocks.directoryActions.rescanServerDirectory).not.toHaveBeenCalled()
	})

	it('SERVER_DIRECTORY_ID отсутствует → importServerDirectory ровно один раз', async () => {
		const { requests } = installServerLibraryMock({ scanStatuses: [STATUS_READY] })
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await waitFor(() =>
			expect(mocks.directoryActions.importServerDirectory).toHaveBeenCalledTimes(1),
		)
		await settle()

		expect(requests.map((request) => request.pathname)).toEqual(['/api/server-library/status'])
		expect(mocks.directoryActions.rescanServerDirectory).not.toHaveBeenCalled()
	})

	it('SERVER_DIRECTORY_ID уже есть → rescanServerDirectory, без import', async () => {
		await putServerDirectory()
		const { requests } = installServerLibraryMock({ scanStatuses: [STATUS_READY] })
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await waitFor(() =>
			expect(mocks.directoryActions.rescanServerDirectory).toHaveBeenCalledTimes(1),
		)
		await settle()

		expect(requests.map((request) => request.pathname)).toEqual(['/api/server-library/status'])
		expect(mocks.directoryActions.importServerDirectory).not.toHaveBeenCalled()
	})

	it('enabled=false: только один status, без import/rescan и без повторов', async () => {
		const disabled: ServerLibraryScanStatus = {
			enabled: false,
			state: 'ready',
			current: 0,
			total: 0,
		}
		const { requests } = installServerLibraryMock({ scanStatuses: [disabled] })
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await waitFor(() => expect(requests).toHaveLength(1))
		await settle(300)

		expect(requests).toHaveLength(1)
		expect(mocks.directoryActions.importServerDirectory).not.toHaveBeenCalled()
		expect(mocks.directoryActions.rescanServerDirectory).not.toHaveBeenCalled()
	})

	it('offline при старте: сети нет; по online — один retry с полным запуском', async () => {
		Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
		const { requests } = installServerLibraryMock({ scanStatuses: [STATUS_READY] })
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await settle(250)
		// Offline: ни одного запроса, никаких действий.
		expect(requests).toHaveLength(0)
		expect(mocks.directoryActions.importServerDirectory).not.toHaveBeenCalled()

		// Retry по online повторно вызывает runSync, который заново читает
		// navigator.onLine: без реального перехода в online повторной попытки не будет.
		Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
		window.dispatchEvent(new Event('online'))
		await waitFor(() =>
			expect(mocks.directoryActions.importServerDirectory).toHaveBeenCalledTimes(1),
		)
		await settle(300)

		// Ровно один retry: повторное online не запускает запуск заново.
		expect(requests).toHaveLength(1)
		window.dispatchEvent(new Event('online'))
		await settle(300)
		expect(requests).toHaveLength(1)
		expect(mocks.directoryActions.importServerDirectory).toHaveBeenCalledTimes(1)
	})

	it('503 status: cached tracks целы, ошибка показана, нет retry loop', async () => {
		await addCachedTrack()
		const fetchMock = stubStatusError(503)
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
		await settle(400)
		window.dispatchEvent(new Event('online'))
		await settle(400)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(mocks.directoryActions.importServerDirectory).not.toHaveBeenCalled()
		expect(mocks.directoryActions.rescanServerDirectory).not.toHaveBeenCalled()
		expect(
			mocks.snackbar.mock.calls.length + mocks.snackbar.unexpectedError.mock.calls.length,
		).toBeGreaterThan(0)
		await expectCachedTrackIntact()
	})

	it('401 status: cached tracks целы, без повторных запросов (нет цикла)', async () => {
		await addCachedTrack()
		const fetchMock = stubStatusError(401)
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
		await settle(400)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(mocks.directoryActions.importServerDirectory).not.toHaveBeenCalled()
		await expectCachedTrackIntact()
	})

	it('network error: кэш не стёрт, retry ограничен одним запуском по online, цикла нет', async () => {
		await addCachedTrack()
		const { requests } = installServerLibraryMock({ networkError: true })
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		await waitFor(() => expect(requests).toHaveLength(1))
		await settle(400)

		// Без online новых попыток нет (без бесконечного retry loop).
		expect(requests).toHaveLength(1)

		// NETWORK_ERROR трактуется как offline-сценарий: допускается ровно
		// ОДИН retry по online; второй online цикл не продлевает.
		window.dispatchEvent(new Event('online'))
		await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2))
		await settle(300)
		expect(requests).toHaveLength(2)
		window.dispatchEvent(new Event('online'))
		await settle(300)
		expect(requests).toHaveLength(2)

		await expectCachedTrackIntact()
	})

	it('guard page lifetime: повторный вызов — no-op, повторного запуска нет', async () => {
		const { requests } = installServerLibraryMock({ scanStatuses: [STATUS_READY] })
		const { startServerLibraryStartupSync } = await importStartup()

		startServerLibraryStartupSync()
		startServerLibraryStartupSync()
		startServerLibraryStartupSync()
		await waitFor(() =>
			expect(mocks.directoryActions.importServerDirectory).toHaveBeenCalledTimes(1),
		)
		await settle(300)

		expect(requests).toHaveLength(1)
		expect(mocks.directoryActions.importServerDirectory).toHaveBeenCalledTimes(1)
	})

	it('новый page lifetime для другого профиля: startup запускается снова (A/B)', async () => {
		const first = installServerLibraryMock({ scanStatuses: [STATUS_READY] })
		const startupA = await importStartup()
		startupA.startServerLibraryStartupSync()
		await waitFor(() =>
			expect(mocks.directoryActions.importServerDirectory).toHaveBeenCalledTimes(1),
		)
		await settle()

		expect(first.requests).toHaveLength(1)

		// Новый page lifetime: другой аккаунт получает свой запуск и свой каталог.
		mocks.userId = '2'
		const second = installServerLibraryMock({ scanStatuses: [STATUS_READY] })
		const startupB = await importStartup()
		startupB.startServerLibraryStartupSync()
		await waitFor(() =>
			expect(mocks.directoryActions.importServerDirectory).toHaveBeenCalledTimes(2),
		)
		await settle()

		expect(second.requests).toHaveLength(1)
	})

	it('startup не блокирует вызывающий код: вызов возвращается до завершения сети', async () => {
		let statusResolved = false
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						setTimeout(() => {
							statusResolved = true
							resolve(
								new Response(JSON.stringify(STATUS_READY), {
									status: 200,
									headers: { 'content-type': 'application/json; charset=utf-8' },
								}),
							)
						}, 400)
					}),
			),
		)
		const { startServerLibraryStartupSync } = await importStartup()

		const returned = startServerLibraryStartupSync()
		expect(statusResolved).toBe(false)
		// Сигнатура контрактная: void — вызов не ждёт auth/status/scan.
		expect(returned).toBeUndefined()
		await waitFor(() => expect(statusResolved).toBe(true))
	})
})
