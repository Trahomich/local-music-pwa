// Контракт: CONTRACTS.md §8–9 — независимые тесты профилей и sync (дополняют
// user-state-sync.test.ts #18): разные аккаунты и anonymous legacy используют
// разные IndexedDB БД и не видят данные друг друга; смена namespace закрывает
// прежнюю БД; server failure не даёт ложного local success; клиент шлёт
// стабильный request id; polling по интервалу/focus применяет только новые
// revision и полностью прекращается после logout; snapshot apply атомарен и
// затрагивает только playlists/playlistEntries/playHistory; local-only записи
// переживают sync. Обязательные регрессии #18: local-only сохранение, focus
// listener cleanup, stale revision race.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserStateAction, UserStateSnapshot } from '#lib/auth/api.ts'
import { snackbar } from '#lib/components/snackbar/snackbar.ts'
import { closeAppDatabase, getDatabase } from '#lib/db/database.ts'
import { onDatabaseChange } from '#lib/db/events.ts'
import { toggleFavoriteTrack } from '#lib/library/playlists-actions.ts'
import { FAVORITE_PLAYLIST_ID, type Track } from '#lib/library/types.ts'
import { applyServerActions } from '#lib/user-state/actions.ts'
import {
	fetchUserStateSnapshot,
	postUserStateActions,
	UserStateRequestError,
} from '#lib/user-state/client.ts'
import { applyUserStateSnapshot } from '#lib/user-state/snapshot.ts'
import { startUserStateSync, stopUserStateSync } from '#lib/user-state/sync.ts'

const mocks = vi.hoisted(() => ({ userId: null as string | null }))

vi.mock('#lib/auth/client.ts', () => ({
	bootstrapAuth: async () =>
		mocks.userId === null
			? { status: 'local-only' }
			: { status: 'authenticated', user: { id: Number(mocks.userId), username: 'user' } },
	getCurrentUserId: () => mocks.userId,
	registerAuthChangeHandler: () => () => {},
}))

vi.mock('#lib/db/lock-database.ts', () => ({
	lockDatabase: <T>(action: () => Promise<T>): Promise<T> => action(),
	isDatabaseOperationPending: () => false,
}))

vi.mock('#lib/components/snackbar/snackbar.ts', () => ({
	snackbar: Object.assign(vi.fn(), {
		unexpectedError: vi.fn(),
		dismiss: vi.fn(),
	}),
}))

/** In-memory §9 server с идемпотентностью по request id (как backend в #21). */
const server = {
	revision: 0,
	playlists: [] as {
		uuid: string
		name: string
		description: string
		createdAt: number
		updatedAt: number
	}[],
	playlistEntries: [] as { playlistUuid: string; trackUuid: string; addedAt: number }[],
	history: [] as { trackUuid: string; playedAt: number }[],
	appliedRequestIds: new Set<string>(),
}

const requests: { method: string; url: string; body?: unknown }[] = []

const snapshotBody = (): UserStateSnapshot => ({
	version: 1,
	revision: server.revision,
	playlists: server.playlists,
	playlistEntries: server.playlistEntries,
	history: server.history,
})

const applyServerAction = (action: UserStateAction): void => {
	switch (action.action) {
		case 'playlist-create':
			server.playlists.push({
				uuid: action.uuid,
				name: action.name,
				description: action.description ?? '',
				createdAt: action.createdAt,
				updatedAt: action.updatedAt,
			})
			break
		case 'playlist-update': {
			const playlist = server.playlists.find((p) => p.uuid === action.uuid)
			if (playlist) {
				playlist.name = action.name ?? playlist.name
				playlist.description = action.description ?? playlist.description
				playlist.updatedAt = action.updatedAt
			}
			break
		}
		case 'playlist-delete':
			server.playlists = server.playlists.filter((p) => p.uuid !== action.uuid)
			server.playlistEntries = server.playlistEntries.filter(
				(e) => e.playlistUuid !== action.uuid,
			)
			break
		case 'playlist-entry-add':
			server.playlistEntries.push({
				playlistUuid: action.playlistUuid,
				trackUuid: action.trackUuid,
				addedAt: action.addedAt,
			})
			break
		case 'playlist-entry-remove':
			server.playlistEntries = server.playlistEntries.filter(
				(e) =>
					!(e.playlistUuid === action.playlistUuid && e.trackUuid === action.trackUuid),
			)
			break
		case 'favorite-set':
			if (action.favorite) {
				server.playlistEntries.push({
					playlistUuid: 'favorites',
					trackUuid: action.trackUuid,
					addedAt: 1000,
				})
			} else {
				server.playlistEntries = server.playlistEntries.filter(
					(e) => !(e.playlistUuid === 'favorites' && e.trackUuid === action.trackUuid),
				)
			}
			break
		case 'history-record':
			server.history = [
				{ trackUuid: action.trackUuid, playedAt: action.playedAt },
				...server.history.filter((h) => h.trackUuid !== action.trackUuid),
			].slice(0, 100)
			break
		case 'history-remove':
			server.history = server.history.filter((h) => h.trackUuid !== action.trackUuid)
			break
		case 'history-clear':
			server.history = []
			break
	}
}

/** fetch-мок: стандартные §9 endpoints поверх in-memory server; флаги для сбоев. */
const fetchControl = {
	failNextGet: null as Response | null,
	hangGet: false,
	hangRelease: null as (() => void) | null,
}

const installFetchMock = () => {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
			requests.push({ method, url, body })

			if (url === '/api/user-state' && method === 'GET') {
				if (fetchControl.failNextGet !== null) {
					const response = fetchControl.failNextGet
					fetchControl.failNextGet = null

					return Promise.resolve(response)
				}
				if (fetchControl.hangGet) {
					return new Promise<Response>((resolve) => {
						fetchControl.hangRelease = () => resolve(Response.json(snapshotBody()))
					})
				}

				return Promise.resolve(Response.json(snapshotBody()))
			}

			if (url === '/api/user-state/actions' && method === 'POST') {
				const requestId = body.id as string
				// Идемпотентность (§9): повтор того же id не применяет действия заново.
				if (!server.appliedRequestIds.has(requestId)) {
					server.appliedRequestIds.add(requestId)
					const actions: UserStateAction[] = body.actions ?? [body.action]
					for (const action of actions) {
						applyServerAction(action)
					}
					server.revision += 1
				}

				return Promise.resolve(Response.json(snapshotBody()))
			}

			return Promise.reject(new Error(`Unexpected request: ${method} ${url}`))
		}),
	)
}

const addTestTrack = async (uuid: string, fileName = `${uuid}.mp3`): Promise<number> => {
	const db = await getDatabase()
	const track: Omit<Track, 'id'> = {
		uuid,
		name: fileName,
		album: 'Album',
		artists: ['Artist'],
		year: '2024',
		duration: 100,
		trackNo: 1,
		trackOf: 1,
		discNo: 1,
		discOf: 1,
		genre: [],
		file: new File(['audio'], fileName, { type: 'audio/mpeg' }),
		scannedAt: Date.now(),
		fileName,
		directory: 0,
	}

	return db.add('tracks', track as Track)
}

const ALL_STORES = [
	'tracks',
	'albums',
	'artists',
	'playlists',
	'playlistEntries',
	'playHistory',
	'directories',
	'images',
] as const

const clearCurrentDatabase = async () => {
	const db = await getDatabase()
	const tx = db.transaction([...ALL_STORES], 'readwrite')
	await Promise.all(ALL_STORES.map((store) => tx.objectStore(store).clear()))
	await tx.done
}

/**
 * Опрос условия на реальных таймерах: vi.waitFor внутри использует setInterval,
 * который в fake-timer тестах замокан, поэтому здесь — свой цикл с реальным
 * setTimeout (он не входит в toFake).
 */
const waitUntil = async (check: () => Promise<boolean> | boolean): Promise<void> => {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (await check()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error('waitUntil: condition not met in time')
}

const resetServer = () => {
	server.revision = 0
	server.playlists = []
	server.playlistEntries = []
	server.history = []
	server.appliedRequestIds.clear()
	requests.length = 0
	fetchControl.failNextGet = null
	fetchControl.hangGet = false
	fetchControl.hangRelease = null
}

beforeEach(async () => {
	resetServer()
	installFetchMock()

	// Каждый тест начинается с пустых БД всех профилей.
	for (const userId of [null, '7', '9']) {
		mocks.userId = userId
		await clearCurrentDatabase()
	}
	mocks.userId = null
})

afterEach(async () => {
	stopUserStateSync()
	await closeAppDatabase()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('HTTP client user-state API (§9)', () => {
	it('GET /api/user-state с Accept: application/json возвращает snapshot', async () => {
		server.revision = 3
		server.playlists = [
			{ uuid: 'p1', name: 'Mix', description: '', createdAt: 1, updatedAt: 1 },
		]

		const snapshot = await fetchUserStateSnapshot()

		expect(snapshot.revision).toBe(3)
		expect(snapshot.playlists).toHaveLength(1)
		expect(requests).toHaveLength(1)
		expect(requests[0]?.url).toBe('/api/user-state')
		expect(requests[0]?.method).toBe('GET')
	})

	it('malformed snapshot (нет version/массивов) → HTTP_ERROR', async () => {
		fetchControl.failNextGet = Response.json({ revision: 'x' })

		const error = await fetchUserStateSnapshot().catch((e: unknown) => e)

		expect(error).toBeInstanceOf(UserStateRequestError)
		expect((error as UserStateRequestError).code).toBe('HTTP_ERROR')
	})

	it('401 → AUTH_REQUIRED; сетевой сбой → NETWORK_ERROR', async () => {
		fetchControl.failNextGet = Response.json(
			{ error: { code: 'AUTH_REQUIRED', message: 'no session' } },
			{ status: 401 },
		)
		const unauthorized = await fetchUserStateSnapshot().catch((e: unknown) => e)
		expect((unauthorized as UserStateRequestError).code).toBe('AUTH_REQUIRED')
		expect((unauthorized as UserStateRequestError).httpStatus).toBe(401)

		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
		const network = await fetchUserStateSnapshot().catch((e: unknown) => e)
		expect((network as UserStateRequestError).code).toBe('NETWORK_ERROR')
		expect((network as UserStateRequestError).httpStatus).toBe(0)
	})

	it('одиночный action шлёт {id, action}; batch — {id, actions} с одним id', async () => {
		mocks.userId = '7'

		await postUserStateActions(
			[{ action: 'history-clear' }],
			'11111111-1111-4111-8111-111111111111',
		)
		await postUserStateActions(
			[
				{ action: 'history-clear' },
				{ action: 'history-record', trackUuid: 'server:x', playedAt: 5 },
			],
			'22222222-2222-4222-8222-222222222222',
		)

		expect(requests[0]?.body).toEqual({
			id: '11111111-1111-4111-8111-111111111111',
			action: { action: 'history-clear' },
		})
		expect(requests[1]?.body).toEqual({
			id: '22222222-2222-4222-8222-222222222222',
			actions: [
				{ action: 'history-clear' },
				{ action: 'history-record', trackUuid: 'server:x', playedAt: 5 },
			],
		})
	})

	it('request id idempotency: повтор того же id не применяет действие дважды', async () => {
		mocks.userId = '7'
		const id = '33333333-3333-4333-8333-333333333333'
		const action: UserStateAction = {
			action: 'playlist-create',
			uuid: 'pl-idem',
			name: 'Idem',
			createdAt: 1,
			updatedAt: 1,
		}

		const first = await postUserStateActions([action], id)
		const second = await postUserStateActions([action], id)

		// Сервер применил действие один раз; оба ответа — полный snapshot.
		expect(first.revision).toBe(1)
		expect(second.revision).toBe(1)
		expect(second.playlists).toHaveLength(1)
		expect(server.playlists).toHaveLength(1)
	})
})

describe('synced actions: update, history, batch (§9)', () => {
	it('playlist-update применяется на сервере и локально с сохранением numeric id', async () => {
		mocks.userId = '7'
		const db = await getDatabase()

		const created = await applyServerActions([
			{
				action: 'playlist-create',
				uuid: 'pl-upd',
				name: 'Old',
				description: 'd0',
				createdAt: 1,
				updatedAt: 1,
			},
		])
		expect(created.revision).toBe(1)
		const localId = (await db.getAll('playlists'))[0]?.id

		const updated = await applyServerActions([
			{
				action: 'playlist-update',
				uuid: 'pl-upd',
				name: 'New name',
				description: 'd1',
				updatedAt: 2,
			},
		])

		expect(updated.revision).toBe(2)
		expect(server.playlists[0]).toMatchObject({
			name: 'New name',
			description: 'd1',
			updatedAt: 2,
		})
		const playlists = await db.getAll('playlists')
		expect(playlists).toHaveLength(1)
		expect(playlists[0]?.id).toBe(localId)
		expect(playlists[0]?.name).toBe('New name')
	})

	it('history-remove удаляет одну запись, history-clear — все', async () => {
		mocks.userId = '7'
		await addTestTrack('server:h1')
		await addTestTrack('server:h2')
		const db = await getDatabase()

		await applyServerActions([
			{ action: 'history-record', trackUuid: 'server:h1', playedAt: 10 },
			{ action: 'history-record', trackUuid: 'server:h2', playedAt: 20 },
		])
		await waitUntil(async () => (await db.getAll('playHistory')).length === 2)

		await applyServerActions([{ action: 'history-remove', trackUuid: 'server:h1' }])
		await waitUntil(async () => (await db.getAll('playHistory')).length === 1)
		expect(server.history).toHaveLength(1)
		expect(server.history[0]?.trackUuid).toBe('server:h2')

		await applyServerActions([{ action: 'history-clear' }])
		await waitUntil(async () => (await db.getAll('playHistory')).length === 0)
		expect(server.history).toHaveLength(0)
	})

	it('batch: несколько actions уходят одним запросом с одним id и одной revision', async () => {
		mocks.userId = '7'
		const trackA = await addTestTrack('server:batch-a')
		const trackB = await addTestTrack('server:batch-b')
		const db = await getDatabase()

		await applyServerActions([
			{
				action: 'playlist-create',
				uuid: 'pl-batch',
				name: 'Batch',
				createdAt: 1,
				updatedAt: 1,
			},
		])
		requests.length = 0

		const snapshot = await applyServerActions([
			{
				action: 'playlist-entry-add',
				playlistUuid: 'pl-batch',
				trackUuid: 'server:batch-a',
				addedAt: 1,
			},
			{
				action: 'playlist-entry-add',
				playlistUuid: 'pl-batch',
				trackUuid: 'server:batch-b',
				addedAt: 2,
			},
			{ action: 'favorite-set', trackUuid: 'server:batch-a', favorite: true },
		])

		// Один POST, массив actions под одним id, revision выросла ровно на 1.
		const posts = requests.filter((r) => r.url === '/api/user-state/actions')
		expect(posts).toHaveLength(1)
		const body = posts[0]?.body as { id: string; actions: UserStateAction[] }
		expect(Array.isArray(body.actions)).toBe(true)
		expect(body.actions).toHaveLength(3)
		expect(snapshot.revision).toBe(2)

		// Все три действия применены атомарно: локально видны обе entries и favorite.
		await waitUntil(async () => (await db.getAll('playlistEntries')).length === 3)
		const entries = await db.getAll('playlistEntries')
		const playlistId = (await db.getAll('playlists'))[0]?.id
		expect(
			entries.some(
				(e) => e.playlistId === playlistId && e.trackId === trackA && e.addedAt === 1,
			),
		).toBe(true)
		expect(
			entries.some(
				(e) => e.playlistId === playlistId && e.trackId === trackB && e.addedAt === 2,
			),
		).toBe(true)
		expect(
			entries.some((e) => e.playlistId === FAVORITE_PLAYLIST_ID && e.trackId === trackA),
		).toBe(true)
	})
})

describe('изоляция профилей IndexedDB (§8–9)', () => {
	it('разные аккаунты и anonymous используют разные БД и не видят чужие данные', async () => {
		// Аккаунт A создаёт playlist.
		mocks.userId = '7'
		const dbA = await getDatabase()
		await dbA.add('playlists', {
			uuid: 'pl-a',
			name: 'A-list',
			description: '',
			createdAt: 1,
		} as never)

		// Аккаунт B не видит данные A.
		mocks.userId = '9'
		const dbB = await getDatabase()
		expect(dbB).not.toBe(dbA)
		expect(await dbB.getAll('playlists')).toHaveLength(0)

		// Anonymous legacy профиль тоже изолирован.
		mocks.userId = null
		const dbAnon = await getDatabase()
		expect(await dbAnon.getAll('playlists')).toHaveLength(0)

		// Возврат к A: данные на месте.
		mocks.userId = '7'
		const dbA2 = await getDatabase()
		const playlistsA = await dbA2.getAll('playlists')
		expect(playlistsA).toHaveLength(1)
		expect(playlistsA[0]?.name).toBe('A-list')
	})

	it('anonymous legacy данные переживают login/logout без копирования в аккаунт', async () => {
		// Данные legacy профиля до появления аккаунтов.
		mocks.userId = null
		const dbAnon = await getDatabase()
		await dbAnon.add('playlists', {
			uuid: 'pl-legacy',
			name: 'Legacy',
			description: '',
			createdAt: 1,
		} as never)
		await dbAnon.add('playHistory', { trackId: 1, playedAt: 5 } as never)

		// Login: аккаунт стартует пустым, legacy данные не копируются.
		mocks.userId = '7'
		const dbAccount = await getDatabase()
		expect(await dbAccount.getAll('playlists')).toHaveLength(0)
		expect(await dbAccount.getAll('playHistory')).toHaveLength(0)

		// Logout: legacy профиль нетронут.
		mocks.userId = null
		const dbAnon2 = await getDatabase()
		const playlists = await dbAnon2.getAll('playlists')
		expect(playlists).toHaveLength(1)
		expect(playlists[0]?.name).toBe('Legacy')
		expect(await dbAnon2.getAll('playHistory')).toHaveLength(1)
	})

	it('смена namespace без reload закрывает прежнюю БД (только в тестах; в app — reload)', async () => {
		mocks.userId = '7'
		const dbA = await getDatabase()
		expect(dbA.name).toBe('snae-app-data-user-7')

		mocks.userId = '9'
		const dbB = await getDatabase()
		expect(dbB.name).toBe('snae-app-data-user-9')

		// Прежнее соединение закрыто: новая транзакция на нём невозможна.
		expect(() => dbA.transaction('playlists', 'readonly')).toThrow()

		// Anonymous БД — прежнее имя, существовавшее до multiuser (§9).
		mocks.userId = null
		const dbAnon = await getDatabase()
		expect(dbAnon.name).toBe('snae-app-data')
	})
})

describe('server failure не даёт ложного local success (§9)', () => {
	it('applyServerActions при 500 бросает и не меняет локальные данные', async () => {
		mocks.userId = '7'
		const db = await getDatabase()

		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ error: { code: 'INTERNAL_ERROR', message: 'boom' } },
						{ status: 500 },
					),
				),
		)

		const error = await applyServerActions([
			{ action: 'playlist-create', uuid: 'pl-x', name: 'X', createdAt: 1, updatedAt: 1 },
		]).catch((e: unknown) => e)

		expect(error).toBeInstanceOf(UserStateRequestError)
		expect((error as UserStateRequestError).code).toBe('INTERNAL_ERROR')
		expect(await db.getAll('playlists')).toHaveLength(0)
		expect(await db.getAll('playlistEntries')).toHaveLength(0)
	})

	it('сетевой сбой favorite: локальный favorite не появляется', async () => {
		mocks.userId = '7'
		const trackId = await addTestTrack('server:fav-fail')

		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

		// Честный провал: операция не выдаётся за сохранённую (false), UI показывает
		// ошибку через snackbar, локальный favorite не появляется.
		const result = await toggleFavoriteTrack(false, trackId)

		expect(result).toBe(false)
		expect(vi.mocked(snackbar.unexpectedError)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(snackbar.unexpectedError).mock.calls[0]?.[0]).toBeInstanceOf(
			UserStateRequestError,
		)
		const db = await getDatabase()
		expect(
			(await db.getAll('playlistEntries')).filter(
				(e) => e.playlistId === FAVORITE_PLAYLIST_ID,
			),
		).toHaveLength(0)
	})
})

describe('polling по интервалу и focus (§9)', () => {
	it('старт делает initial fetch, дальше — каждые 30 секунд; новая revision применяется', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
		mocks.userId = '7'
		const trackId = await addTestTrack('server:poll-interval')

		startUserStateSync()
		await waitUntil(() => requests.filter((r) => r.method === 'GET').length === 1)
		// Дожидаемся конца initial poll (requestInFlight освобождается).
		await new Promise((resolve) => setTimeout(resolve, 30))

		// «Другое устройство»: на сервере появился playlist, revision выросла.
		server.playlists = [
			{ uuid: 'pl-remote', name: 'Remote', description: '', createdAt: 1, updatedAt: 1 },
		]
		server.playlistEntries = [
			{ playlistUuid: 'pl-remote', trackUuid: 'server:poll-interval', addedAt: 50 },
		]
		server.revision = 1

		await vi.advanceTimersByTimeAsync(30_000)
		const db = await getDatabase()
		await waitUntil(async () => (await db.getAll('playlists')).length === 1)
		const entries = await db.getAll('playlistEntries')
		expect(entries).toHaveLength(1)
		expect(entries[0]?.trackId).toBe(trackId)

		// Ещё интервал — ещё один GET (polling живёт).
		await vi.advanceTimersByTimeAsync(30_000)
		await waitUntil(() => requests.filter((r) => r.method === 'GET').length >= 3)
	})

	it('после logout polling и focus полностью прекращаются (регрессия #18)', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
		mocks.userId = '7'

		startUserStateSync()
		await waitUntil(() => requests.filter((r) => r.method === 'GET').length === 1)
		await new Promise((resolve) => setTimeout(resolve, 30))

		// Logout: следующий тик видит null user id и останавливает sync.
		mocks.userId = null
		await vi.advanceTimersByTimeAsync(30_000)
		await new Promise((resolve) => setTimeout(resolve, 30))
		const countAfterLogout = requests.length

		// Ни интервал, ни focus/visibility больше не делают запросов.
		await vi.advanceTimersByTimeAsync(90_000)
		window.dispatchEvent(new Event('focus'))
		document.dispatchEvent(new Event('visibilitychange'))
		await new Promise((resolve) => setTimeout(resolve, 30))

		expect(requests).toHaveLength(countAfterLogout)
	})

	it('focus listener не дублируется и снимается при stop (регрессия #18)', async () => {
		mocks.userId = '7'
		const addSpy = vi.spyOn(window, 'addEventListener')
		const removeSpy = vi.spyOn(window, 'removeEventListener')

		startUserStateSync()
		await vi.waitFor(() => {
			expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1)
		})
		// Повторный start — no-op: слушатель остаётся один.
		startUserStateSync()
		const focusAdds = addSpy.mock.calls.filter((c) => String(c[0]) === 'focus')
		expect(focusAdds).toHaveLength(1)

		stopUserStateSync()
		const focusRemoves = removeSpy.mock.calls.filter((c) => String(c[0]) === 'focus')
		expect(focusRemoves).toHaveLength(1)
		expect(focusRemoves[0]?.[1]).toBe(focusAdds[0]?.[1])

		// После stop focus не делает запросов.
		const count = requests.length
		window.dispatchEvent(new Event('focus'))
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(requests).toHaveLength(count)

		addSpy.mockRestore()
		removeSpy.mockRestore()
	})

	it('stale revision race: поздний ответ старого poll не откатывает новое состояние (регрессия #18)', async () => {
		mocks.userId = '7'
		await addTestTrack('server:race')

		// Initial GET зависает.
		fetchControl.hangGet = true
		startUserStateSync()
		await vi.waitFor(() => {
			expect(fetchControl.hangRelease).not.toBeNull()
		})

		// Server-first действие применяет revision 1 и playlist 'Fresh'.
		const snapshot = await applyServerActions([
			{
				action: 'playlist-create',
				uuid: 'pl-fresh',
				name: 'Fresh',
				createdAt: 1,
				updatedAt: 1,
			},
			{ action: 'favorite-set', trackUuid: 'server:race', favorite: true },
		])
		expect(snapshot.revision).toBe(1)

		const db = await getDatabase()
		await vi.waitFor(async () => {
			expect(await db.getAll('playlists')).toHaveLength(1)
		})

		// Сервер «откатывается» к revision 0 (устаревший ответ повисшего GET).
		server.revision = 0
		server.playlists = []
		server.playlistEntries = []
		fetchControl.hangRelease?.()
		await new Promise((resolve) => setTimeout(resolve, 30))

		// Локальное состояние не откатилось: playlist и favorite на месте.
		expect(await db.getAll('playlists')).toHaveLength(1)
		expect(
			(await db.getAll('playlistEntries')).filter(
				(e) => e.playlistId === FAVORITE_PLAYLIST_ID,
			),
		).toHaveLength(1)
	})
})

describe('snapshot apply: атомарность и границы stores (§9)', () => {
	it('apply затрагивает только playlists/playlistEntries/playHistory, не трогая библиотеку', async () => {
		mocks.userId = '7'
		const db = await getDatabase()
		const trackId = await addTestTrack('server:keep')

		// Заполняем «библиотечные» stores.
		await db.add('albums', { uuid: 'al-1', name: 'Album', artists: [], year: '2024' } as never)
		await db.add('artists', { uuid: 'ar-1', name: 'Artist' } as never)
		await db.add('directories', { id: 0, name: 'root', addedAt: 1 } as never)
		await db.add('images', { hash: 'h1', blob: new Blob(['x']) } as never)

		const changesSeen: string[][] = []
		const unsubscribe = onDatabaseChange((changes) => {
			changesSeen.push(changes.map((c) => c.storeName))
		})

		await applyUserStateSnapshot({
			version: 1,
			revision: 4,
			playlists: [{ uuid: 'pl-1', name: 'Mix', description: '', createdAt: 1, updatedAt: 1 }],
			playlistEntries: [{ playlistUuid: 'pl-1', trackUuid: 'server:keep', addedAt: 10 }],
			history: [{ trackUuid: 'server:keep', playedAt: 20 }],
		})

		unsubscribe()

		// Библиотечные stores не изменились.
		expect(await db.getAll('albums')).toHaveLength(1)
		expect(await db.getAll('artists')).toHaveLength(1)
		expect(await db.getAll('directories')).toHaveLength(1)
		expect(await db.getAll('images')).toHaveLength(1)
		expect(await db.get('tracks', trackId)).toBeDefined()

		// Изменения пришли по sync-stores (tracks в событиях нет).
		const touched = new Set(changesSeen.flat())
		expect(touched.has('playlists')).toBe(true)
		expect(touched.has('playlistEntries')).toBe(true)
		expect(touched.has('playHistory')).toBe(true)
		expect(touched.has('tracks')).toBe(false)
		expect(touched.has('albums')).toBe(false)
	})

	it('local-only записи переживают чужой snapshot с теми же id (регрессия #18)', async () => {
		mocks.userId = '7'
		const db = await getDatabase()
		await addTestTrack('server:synced')
		const localTrackId = await addTestTrack('local:mine')

		// Локальные записи local-only трека.
		const localEntryId = (await db.add('playlistEntries', {
			playlistId: FAVORITE_PLAYLIST_ID,
			trackId: localTrackId,
			addedAt: 77,
		} as never)) as number
		const localHistoryId = (await db.add('playHistory', {
			trackId: localTrackId,
			playedAt: 88,
		} as never)) as number

		// Snapshot «другого устройства»: synced трек в playlist и history.
		await applyUserStateSnapshot({
			version: 1,
			revision: 1,
			playlists: [{ uuid: 'pl-1', name: 'Mix', description: '', createdAt: 1, updatedAt: 1 }],
			playlistEntries: [{ playlistUuid: 'pl-1', trackUuid: 'server:synced', addedAt: 10 }],
			history: [{ trackUuid: 'server:synced', playedAt: 20 }],
		})

		// Local-only записи сохранились с теми же id; synced добавились.
		const entries = await db.getAll('playlistEntries')
		expect(entries).toContainEqual(
			expect.objectContaining({
				id: localEntryId,
				playlistId: FAVORITE_PLAYLIST_ID,
				trackId: localTrackId,
				addedAt: 77,
			}),
		)
		expect(entries).toHaveLength(2)
		const history = await db.getAll('playHistory')
		expect(history).toContainEqual(
			expect.objectContaining({ id: localHistoryId, trackId: localTrackId, playedAt: 88 }),
		)
		expect(history).toHaveLength(2)

		// Следующий snapshot убрал synced трек отовсюду: synced записи исчезли,
		// local-only по-прежнему нетронуты.
		await applyUserStateSnapshot({
			version: 1,
			revision: 2,
			playlists: [],
			playlistEntries: [],
			history: [],
		})

		const entriesAfter = await db.getAll('playlistEntries')
		expect(entriesAfter).toHaveLength(1)
		expect(entriesAfter[0]?.id).toBe(localEntryId)
		const historyAfter = await db.getAll('playHistory')
		expect(historyAfter).toHaveLength(1)
		expect(historyAfter[0]?.id).toBe(localHistoryId)
		// Пустой snapshot удалил и сам playlist.
		expect(await db.getAll('playlists')).toHaveLength(0)
	})
})
