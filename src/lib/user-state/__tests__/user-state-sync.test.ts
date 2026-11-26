// Контракт: CONTRACTS.md §9 — клиентская синхронизация user-state: snapshot
// применяется атомарно только к playlists/playlistEntries/playHistory с маппингом
// UUID↔numeric ids; действия сначала идут на сервер и только потом локально;
// local-only режим не делает ни одного сетевого вызова; local-only треки не
// отправляются на сервер; удаление треков не оставляет серверных dangling entries;
// polling стартует только для активного аккаунта и не применяет тот же revision дважды.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
	UserStateAction,
	UserStateHistoryEntry,
	UserStatePlaylist,
	UserStatePlaylistEntry,
	UserStateSnapshot,
} from '#lib/auth/api.ts'
import { getDatabase } from '#lib/db/database.ts'
import { dbAddToPlayHistory } from '#lib/library/play-history-actions.ts'
import {
	dbBatchModifyPlaylistsSelection,
	dbCreatePlaylist,
	dbRemovePlaylist,
	toggleFavoriteTrack,
} from '#lib/library/playlists-actions.ts'
import { dbRemoveTracks } from '#lib/library/remove.ts'
import { FAVORITE_PLAYLIST_ID, type Track } from '#lib/library/types.ts'
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

/** Minimal in-memory §9 server: applies actions and returns full snapshots. */
const server = {
	revision: 0,
	playlists: [] as UserStatePlaylist[],
	playlistEntries: [] as UserStatePlaylistEntry[],
	history: [] as UserStateHistoryEntry[],
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
					addedAt: Date.now(),
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

const installFetchMock = () => {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
			requests.push({ method, url, body })

			if (url === '/api/user-state' && method === 'GET') {
				return Promise.resolve(Response.json(snapshotBody()))
			}

			if (url === '/api/user-state/actions' && method === 'POST') {
				const actions: UserStateAction[] = body.actions ?? [body.action]
				for (const action of actions) {
					applyServerAction(action)
				}
				server.revision += 1

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

const resetServer = () => {
	server.revision = 0
	server.playlists = []
	server.playlistEntries = []
	server.history = []
	requests.length = 0
}

const clearCurrentDatabase = async () => {
	const db = await getDatabase()
	const tx = db.transaction(
		[
			'tracks',
			'albums',
			'artists',
			'playlists',
			'playlistEntries',
			'playHistory',
			'directories',
			'images',
		],
		'readwrite',
	)
	await Promise.all(
		(
			[
				'tracks',
				'albums',
				'artists',
				'playlists',
				'playlistEntries',
				'playHistory',
				'directories',
				'images',
			] as const
		).map((store) => tx.objectStore(store).clear()),
	)
	await tx.done
}

beforeEach(async () => {
	resetServer()
	installFetchMock()

	// Both the anonymous profile and the account profile are isolated
	// databases; each test starts from empty ones.
	mocks.userId = null
	await clearCurrentDatabase()
	mocks.userId = '7'
	await clearCurrentDatabase()
	mocks.userId = null
})

afterEach(() => {
	stopUserStateSync()
	vi.unstubAllGlobals()
})

describe('applyUserStateSnapshot', () => {
	it('maps wire UUIDs to local numeric ids, keeps favorites at -1 and skips unknown tracks', async () => {
		const trackId = await addTestTrack('server:track-1')
		const localTrackId = await addTestTrack('local-random-uuid')

		const snapshot: UserStateSnapshot = {
			version: 1,
			revision: 5,
			playlists: [
				{ uuid: 'pl-1', name: 'Mix', description: 'd', createdAt: 10, updatedAt: 20 },
			],
			playlistEntries: [
				{ playlistUuid: 'pl-1', trackUuid: 'server:track-1', addedAt: 100 },
				{ playlistUuid: 'favorites', trackUuid: 'server:track-1', addedAt: 101 },
				{ playlistUuid: 'pl-1', trackUuid: 'server:unknown', addedAt: 102 },
			],
			history: [
				{ trackUuid: 'server:track-1', playedAt: 200 },
				{ trackUuid: 'server:unknown', playedAt: 201 },
			],
		}

		await applyUserStateSnapshot(snapshot)

		const db = await getDatabase()
		const playlists = await db.getAll('playlists')
		expect(playlists).toHaveLength(1)
		expect(playlists[0]?.name).toBe('Mix')

		const playlistId = playlists[0]?.id as number
		const entries = await db.getAll('playlistEntries')
		expect(entries).toHaveLength(2)
		expect(
			entries.some(
				(e) => e.playlistId === playlistId && e.trackId === trackId && e.addedAt === 100,
			),
		).toBe(true)
		expect(
			entries.some(
				(e) =>
					e.playlistId === FAVORITE_PLAYLIST_ID &&
					e.trackId === trackId &&
					e.addedAt === 101,
			),
		).toBe(true)

		const history = await db.getAll('playHistory')
		expect(history).toHaveLength(1)
		expect(history[0]?.trackId).toBe(trackId)

		// Re-applying the same snapshot keeps numeric ids stable (no churn for open UI).
		const entryIdsBefore = entries.map((e) => e.id).sort()
		await applyUserStateSnapshot(snapshot)
		const entryIdsAfter = (await db.getAll('playlistEntries')).map((e) => e.id).sort()
		expect(entryIdsAfter).toEqual(entryIdsBefore)

		// Local-only tracks are untouched by the snapshot machinery.
		expect(await db.get('tracks', localTrackId)).toBeDefined()
	})

	it('keeps local-only entries and history while diffing synced records', async () => {
		const db = await getDatabase()
		const serverTrackId = await addTestTrack('server:diff')
		const localTrackId = await addTestTrack('local-diff')

		const playlistId = (await db.add('playlists', {
			uuid: 'pl-diff',
			name: 'Diff',
			description: '',
			createdAt: 1,
		} as never)) as number

		const serverEntryId = (await db.add('playlistEntries', {
			playlistId,
			trackId: serverTrackId,
			addedAt: 100,
		} as never)) as number
		await db.add('playlistEntries', {
			playlistId: FAVORITE_PLAYLIST_ID,
			trackId: serverTrackId,
			addedAt: 101,
		} as never)
		const localEntryId = (await db.add('playlistEntries', {
			playlistId,
			trackId: localTrackId,
			addedAt: 102,
		} as never)) as number
		const localFavoriteId = (await db.add('playlistEntries', {
			playlistId: FAVORITE_PLAYLIST_ID,
			trackId: localTrackId,
			addedAt: 103,
		} as never)) as number
		await db.add('playHistory', { trackId: serverTrackId, playedAt: 200 } as never)
		const localHistoryId = (await db.add('playHistory', {
			trackId: localTrackId,
			playedAt: 201,
		} as never)) as number

		// Full mirror: server records round-trip, local-only ones coexist.
		await applyUserStateSnapshot({
			version: 1,
			revision: 1,
			playlists: [
				{ uuid: 'pl-diff', name: 'Diff', description: '', createdAt: 1, updatedAt: 1 },
			],
			playlistEntries: [
				{ playlistUuid: 'pl-diff', trackUuid: 'server:diff', addedAt: 100 },
				{ playlistUuid: 'favorites', trackUuid: 'server:diff', addedAt: 101 },
			],
			history: [{ trackUuid: 'server:diff', playedAt: 200 }],
		})

		expect(await db.getAll('playlistEntries')).toHaveLength(4)
		expect(await db.getAll('playHistory')).toHaveLength(2)

		// Other device: server track removed from the playlist and favorites,
		// its history cleared; its addedAt in the playlist changed.
		await applyUserStateSnapshot({
			version: 1,
			revision: 2,
			playlists: [
				{ uuid: 'pl-diff', name: 'Diff', description: '', createdAt: 1, updatedAt: 2 },
			],
			playlistEntries: [{ playlistUuid: 'pl-diff', trackUuid: 'server:diff', addedAt: 150 }],
			history: [],
		})

		const entries = await db.getAll('playlistEntries')
		// Local-only records survive with their ids and values untouched.
		expect(entries).toContainEqual(
			expect.objectContaining({
				id: localEntryId,
				playlistId,
				trackId: localTrackId,
				addedAt: 102,
			}),
		)
		expect(entries).toContainEqual(
			expect.objectContaining({
				id: localFavoriteId,
				playlistId: FAVORITE_PLAYLIST_ID,
				trackId: localTrackId,
				addedAt: 103,
			}),
		)
		// Synced records are updated/removed: favorite gone, entry re-added with
		// the new addedAt, the stale id does not survive.
		expect(entries).toContainEqual(
			expect.objectContaining({ playlistId, trackId: serverTrackId, addedAt: 150 }),
		)
		expect(entries.some((e) => e.id === serverEntryId)).toBe(false)
		expect(
			entries.some(
				(e) => e.playlistId === FAVORITE_PLAYLIST_ID && e.trackId === serverTrackId,
			),
		).toBe(false)
		expect(entries).toHaveLength(3)

		const history = await db.getAll('playHistory')
		expect(history).toContainEqual(
			expect.objectContaining({ id: localHistoryId, trackId: localTrackId, playedAt: 201 }),
		)
		expect(history.some((h) => h.trackId === serverTrackId)).toBe(false)
	})

	it('deletes playlists missing from the snapshot and updates changed ones', async () => {
		const db = await getDatabase()
		const keepId = await db.add('playlists', {
			uuid: 'pl-keep',
			name: 'Old name',
			description: '',
			createdAt: 1,
		} as never)
		await db.add('playlists', {
			uuid: 'pl-gone',
			name: 'Gone',
			description: '',
			createdAt: 2,
		} as never)

		await applyUserStateSnapshot({
			version: 1,
			revision: 2,
			playlists: [
				{ uuid: 'pl-keep', name: 'New name', description: 'x', createdAt: 1, updatedAt: 3 },
			],
			playlistEntries: [],
			history: [],
		})

		const playlists = await db.getAll('playlists')
		expect(playlists).toHaveLength(1)
		expect(playlists[0]?.id).toBe(keepId)
		expect(playlists[0]?.name).toBe('New name')
	})
})

describe('synced actions', () => {
	it('creates a playlist through the server and returns the local numeric id', async () => {
		mocks.userId = '7'

		const id = await dbCreatePlaylist('Road', 'trip')

		expect(id).toBeGreaterThan(0)
		const postRequests = requests.filter((r) => r.url === '/api/user-state/actions')
		expect(postRequests).toHaveLength(1)
		expect(postRequests[0]?.body).toMatchObject({
			action: { action: 'playlist-create', name: 'Road', description: 'trip' },
		})

		const db = await getDatabase()
		const playlist = await db.get('playlists', id)
		expect(playlist?.name).toBe('Road')
		expect(server.playlists).toHaveLength(1)
	})

	it('sends favorite-set only for server tracks; local-only tracks stay local', async () => {
		mocks.userId = '7'
		const serverTrackId = await addTestTrack('server:abc')
		const localTrackId = await addTestTrack('local-xyz')

		expect(await toggleFavoriteTrack(false, serverTrackId)).toBe(true)
		expect(await toggleFavoriteTrack(false, localTrackId)).toBe(true)

		const posts = requests.filter((r) => r.url === '/api/user-state/actions')
		expect(posts).toHaveLength(1)
		expect(posts[0]?.body).toMatchObject({
			action: { action: 'favorite-set', trackUuid: 'server:abc', favorite: true },
		})

		const db = await getDatabase()
		const entries = await db.getAll('playlistEntries')
		// Both tracks are favorites locally: the server one via snapshot apply,
		// the local-only one via the plain local path.
		expect(entries.filter((e) => e.playlistId === FAVORITE_PLAYLIST_ID)).toHaveLength(2)
	})

	it('records history on the server for server tracks only', async () => {
		mocks.userId = '7'
		const serverTrackId = await addTestTrack('server:hist')
		const localTrackId = await addTestTrack('local-hist')

		await dbAddToPlayHistory(serverTrackId)
		await dbAddToPlayHistory(localTrackId)

		const posts = requests.filter((r) => r.url === '/api/user-state/actions')
		expect(posts).toHaveLength(1)
		expect(posts[0]?.body).toMatchObject({
			action: { action: 'history-record', trackUuid: 'server:hist' },
		})

		const db = await getDatabase()
		expect(await db.getAll('playHistory')).toHaveLength(2)
	})

	it('cleans server playlist/history references when tracks are removed', async () => {
		mocks.userId = '7'
		const trackId = await addTestTrack('server:gone')

		const playlistId = await dbCreatePlaylist('Mix', '')
		await dbBatchModifyPlaylistsSelection({
			trackIds: [trackId],
			playlistsIdsAddTo: [playlistId],
			playlistsIdsRemoveFrom: [],
		})
		await toggleFavoriteTrack(false, trackId)
		await dbAddToPlayHistory(trackId)

		await dbRemoveTracks([trackId])

		const removalPost = requests.filter((r) => r.url === '/api/user-state/actions').at(-1)
		expect(removalPost).toBeDefined()
		const removalBody = removalPost?.body as {
			actions?: UserStateAction[]
			action?: UserStateAction
		}
		const actions = removalBody.actions ?? (removalBody.action ? [removalBody.action] : [])

		const playlistUuid = server.playlists[0]?.uuid
		expect(actions).toContainEqual({
			action: 'playlist-entry-remove',
			playlistUuid,
			trackUuid: 'server:gone',
		})
		expect(actions).toContainEqual({
			action: 'favorite-set',
			trackUuid: 'server:gone',
			favorite: false,
		})
		expect(actions).toContainEqual({ action: 'history-remove', trackUuid: 'server:gone' })

		// Server state has no dangling entries for the removed track.
		expect(server.playlistEntries.filter((e) => e.trackUuid === 'server:gone')).toHaveLength(0)
		expect(server.history.filter((h) => h.trackUuid === 'server:gone')).toHaveLength(0)

		const db = await getDatabase()
		expect(await db.get('tracks', trackId)).toBeUndefined()
		expect(await db.getAll('playlistEntries')).toHaveLength(0)
	})

	it('deletes playlists through the server', async () => {
		mocks.userId = '7'
		const playlistId = await dbCreatePlaylist('Temp', '')
		const playlistUuid = server.playlists[0]?.uuid

		await dbRemovePlaylist(playlistId)

		const posts = requests.filter((r) => r.url === '/api/user-state/actions')
		expect(posts.at(-1)?.body).toMatchObject({
			action: { action: 'playlist-delete', uuid: playlistUuid },
		})
		expect(server.playlists).toHaveLength(0)

		const db = await getDatabase()
		expect(await db.getAll('playlists')).toHaveLength(0)
	})
})

describe('local-only mode', () => {
	it('never touches the network and keeps the previous behavior', async () => {
		const trackId = await addTestTrack('server:abc')

		const playlistId = await dbCreatePlaylist('Local', '')
		await toggleFavoriteTrack(false, trackId)
		await dbAddToPlayHistory(trackId)
		await dbBatchModifyPlaylistsSelection({
			trackIds: [trackId],
			playlistsIdsAddTo: [playlistId],
			playlistsIdsRemoveFrom: [],
		})
		await dbRemovePlaylist(playlistId)

		expect(requests).toHaveLength(0)

		const db = await getDatabase()
		expect(await db.getAll('playlists')).toHaveLength(0)
		expect(await db.getAll('playHistory')).toHaveLength(1)
	})
})

describe('polling', () => {
	it('does not start without an account', () => {
		startUserStateSync()
		expect(requests).toHaveLength(0)
	})

	it('applies the initial snapshot once for an account and not twice for the same revision', async () => {
		mocks.userId = '7'
		await addTestTrack('server:poll')
		server.playlists = [
			{ uuid: 'pl-poll', name: 'Polled', description: '', createdAt: 1, updatedAt: 1 },
		]
		server.revision = 3

		startUserStateSync()
		await vi.waitFor(() => {
			expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1)
		})

		const db = await getDatabase()
		await vi.waitFor(async () => {
			expect(await db.getAll('playlists')).toHaveLength(1)
		})

		// Same revision on focus: no re-apply, playlist id stays stable.
		const playlistIdBefore = (await db.getAll('playlists'))[0]?.id
		window.dispatchEvent(new Event('focus'))
		await vi.waitFor(() => {
			expect(requests.filter((r) => r.method === 'GET')).toHaveLength(2)
		})
		expect((await db.getAll('playlists'))[0]?.id).toBe(playlistIdBefore)
	})

	it('removes the exact focus/visibility listeners it added once sync stops on logout', async () => {
		mocks.userId = '7'
		const addSpy = vi.spyOn(window, 'addEventListener')
		const removeSpy = vi.spyOn(window, 'removeEventListener')
		const documentAddSpy = vi.spyOn(document, 'addEventListener')
		const documentRemoveSpy = vi.spyOn(document, 'removeEventListener')

		startUserStateSync()
		await vi.waitFor(() => {
			expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1)
		})
		// Let the initial poll finish so requestInFlight no longer short-circuits ticks.
		await new Promise((resolve) => setTimeout(resolve, 20))

		const focusListener = addSpy.mock.calls.find((c) => String(c[0]) === 'focus')?.[1]
		const visibilityListener = documentAddSpy.mock.calls.find(
			(c) => c[0] === 'visibilitychange',
		)?.[1]
		expect(focusListener).toBeDefined()
		expect(visibilityListener).toBeDefined()

		// Logout: the next poll tick stops sync and must detach both listeners.
		mocks.userId = null
		window.dispatchEvent(new Event('focus'))
		await vi.waitFor(() => {
			expect(
				removeSpy.mock.calls.some(
					(c) => String(c[0]) === 'focus' && c[1] === focusListener,
				),
			).toBe(true)
		})
		expect(
			documentRemoveSpy.mock.calls.some(
				(c) => c[0] === 'visibilitychange' && c[1] === visibilityListener,
			),
		).toBe(true)

		// Detached listeners no longer trigger polls.
		const getCount = requests.filter((r) => r.method === 'GET').length
		window.dispatchEvent(new Event('focus'))
		document.dispatchEvent(new Event('visibilitychange'))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(requests.filter((r) => r.method === 'GET')).toHaveLength(getCount)
	})

	it('ignores an older delayed poll snapshot after a newer server-first action', async () => {
		mocks.userId = '7'
		const trackId = await addTestTrack('server:defer')

		const initialGet: { release: (() => void) | null } = { release: null }
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const url = String(input)
				const method = init?.method ?? 'GET'
				if (url === '/api/user-state' && method === 'GET') {
					return new Promise<Response>((resolve) => {
						initialGet.release = () => resolve(Response.json(snapshotBody()))
					})
				}
				if (url === '/api/user-state/actions' && method === 'POST') {
					const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
					const actions: UserStateAction[] = body.actions ?? [body.action]
					for (const action of actions) {
						applyServerAction(action)
					}
					server.revision += 1

					return Promise.resolve(Response.json(snapshotBody()))
				}

				return Promise.reject(new Error(`Unexpected request: ${method} ${url}`))
			}),
		)

		// Initial poll GET hangs; meanwhile a server-first action advances the
		// server to revision 1 and applies the returned snapshot locally.
		startUserStateSync()
		await vi.waitFor(() => {
			expect(initialGet.release).not.toBeNull()
		})

		await toggleFavoriteTrack(false, trackId)

		const db = await getDatabase()
		await vi.waitFor(async () => {
			expect(
				(await db.getAll('playlistEntries')).filter(
					(e) => e.playlistId === FAVORITE_PLAYLIST_ID,
				),
			).toHaveLength(1)
		})

		// The stale initial snapshot (revision 0) arrives late and must be dropped
		// instead of rolling the applied action state back.
		initialGet.release?.()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(
			(await db.getAll('playlistEntries')).filter(
				(e) => e.playlistId === FAVORITE_PLAYLIST_ID,
			),
		).toHaveLength(1)
	})
})
