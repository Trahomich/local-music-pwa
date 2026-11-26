// Контракт: CONTRACTS.md §12 — независимые контрактные проверки пакетного
// скачивания (дополняют downloads.test.ts автора реализации): дубликаты
// entries одного трека считаются один раз; quota-ошибка в середине batch
// увеличивает failed и не останавливает остальные, partial не сохраняется;
// Blob хранится с MIME от file endpoint; пустой плейлист — total 0 без
// запросов; треки вне плейлиста не скачиваются.
import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAppDatabase, getDatabase } from '#lib/db/database.ts'
import { clearDatabaseStores } from '#lib/helpers/test-helpers.ts'
import { SERVER_DIRECTORY_ID, type Track } from '#lib/library/types.ts'
import { downloadPlaylist } from '#lib/offline/downloads.ts'
import { getOfflineTrack } from '#lib/offline/store.ts'

const mocks = vi.hoisted(() => ({ userId: null as string | null }))

vi.mock('#lib/auth/client.ts', () => ({
	bootstrapAuth: async () =>
		mocks.userId === null
			? { status: 'local-only' }
			: { status: 'authenticated', user: { id: Number(mocks.userId), username: 'user' } },
	getCurrentUserId: () => mocks.userId,
	registerAuthChangeHandler: () => () => {},
}))

const serverFiles = new Map<string, Uint8Array<ArrayBuffer>>()
const fetchCalls: string[] = []

// Blob из happy-dom не переживает structuredClone в fake-indexeddb; MIME-проверка
// поэтому требует нативного blob в fetch-стабе — как в браузере.
const stubFetch = () => {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === 'string' ? input : input.toString()
			const path = new URL(url, 'http://localhost').searchParams.get('path')
			if (path === null) {
				return Promise.resolve({ ok: false, status: 400 } as Response)
			}
			fetchCalls.push(path)

			const bytes = serverFiles.get(path)
			if (bytes === undefined) {
				return Promise.resolve({ ok: false, status: 404 } as Response)
			}

			const mime = path.endsWith('.flac') ? 'audio/flac' : 'audio/mpeg'

			return Promise.resolve({
				ok: true,
				status: 200,
				blob: async () => new NodeBlob([bytes], { type: mime }),
			} as unknown as Response)
		}),
	)
}

let trackCounter = 0

const makeTrack = (fileName: string, content: string): Track => {
	trackCounter += 1
	const id = trackCounter
	const path = `music/${fileName}`
	const bytes = new Uint8Array(new TextEncoder().encode(content))
	serverFiles.set(path, bytes)

	return {
		id,
		uuid: `server:contract:${path}`,
		directory: SERVER_DIRECTORY_ID,
		file: {
			kind: 'server',
			path,
			name: fileName,
			size: bytes.length,
			lastModified: 1000,
		},
	} as Track
}

const dbAddTrack = async (track: Track): Promise<Track> => {
	const db = await getDatabase()
	await db.put('tracks', track)

	return track
}

const dbAddPlaylist = async (id: number, trackIds: readonly number[]): Promise<void> => {
	const db = await getDatabase()
	await db.put('playlists', {
		id,
		uuid: `playlist-uuid-${id}`,
		name: `Playlist ${id}`,
		description: '',
		createdAt: 1000,
	})

	for (const trackId of trackIds) {
		await db.add('playlistEntries', {
			playlistId: id,
			trackId,
			addedAt: 1000,
		} as never)
	}
}

describe('пакетное скачивание: контрактные проверки (CONTRACTS.md §12)', () => {
	beforeEach(async () => {
		mocks.userId = null
		await closeAppDatabase()
		await clearDatabaseStores()
		serverFiles.clear()
		fetchCalls.length = 0
		trackCounter = 0
		stubFetch()
	})

	afterEach(async () => {
		mocks.userId = null
		await closeAppDatabase()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('дубликаты entries одного трека скачиваются и считаются ровно один раз', async () => {
		const track = await dbAddTrack(makeTrack('dup.mp3', 'dup-bytes!'))

		await dbAddPlaylist(1, [track.id, track.id, track.id])

		const result = await downloadPlaylist(1)

		expect(result).toEqual({
			total: 1,
			downloaded: 1,
			current: 0,
			skippedLocal: 0,
			failed: 0,
			cancelled: false,
		})
		expect(fetchCalls).toEqual(['music/dup.mp3'])
		expect(await getOfflineTrack(track.uuid)).toBeDefined()
	})

	it('quota-ошибка в середине batch: failed++, остальные треки докачиваются, partial нет', async () => {
		const bad = await dbAddTrack(makeTrack('bad.mp3', 'bad-bytes!'))
		const goodOne = await dbAddTrack(makeTrack('good-1.mp3', 'good-one-!'))
		const goodTwo = await dbAddTrack(makeTrack('good-2.mp3', 'good-two-!'))
		await dbAddPlaylist(1, [bad.id, goodOne.id, goodTwo.id])

		const originalPut = IDBObjectStore.prototype.put
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
			this: IDBObjectStore,
			value: unknown,
		) {
			if ((value as { trackUuid?: string }).trackUuid === bad.uuid) {
				return Promise.reject(new DOMException('quota exceeded', 'QuotaExceededError'))
			}

			return originalPut.call(this, value)
		} as unknown as typeof IDBObjectStore.prototype.put)

		const result = await downloadPlaylist(1)

		expect(result).toMatchObject({
			total: 3,
			downloaded: 2,
			failed: 1,
			cancelled: false,
		})
		expect(await getOfflineTrack(bad.uuid)).toBeUndefined()
		expect(await getOfflineTrack(goodOne.uuid)).toBeDefined()
		expect(await getOfflineTrack(goodTwo.uuid)).toBeDefined()
		expect(fetchCalls).toHaveLength(3)
	})

	it('Blob сохраняется с MIME от file endpoint, без перезаписи', async () => {
		const track = await dbAddTrack(makeTrack('lossless.flac', 'flac-bytes'))
		await dbAddPlaylist(1, [track.id])

		await downloadPlaylist(1)

		const record = await getOfflineTrack(track.uuid)
		expect(record).toBeDefined()
		expect(record?.blob.type).toBe('audio/flac')
		expect(record?.size).toBe(new TextEncoder().encode('flac-bytes').length)
	})

	it('пустой плейлист: total 0, без запросов и ошибки', async () => {
		await dbAddPlaylist(1, [])

		const result = await downloadPlaylist(1)

		expect(result).toEqual({
			total: 0,
			downloaded: 0,
			current: 0,
			skippedLocal: 0,
			failed: 0,
			cancelled: false,
		})
		expect(fetchCalls).toHaveLength(0)
	})

	it('треки вне выбранного плейлиста не скачиваются', async () => {
		const inside = await dbAddTrack(makeTrack('inside.mp3', 'inside-!'))
		const outside = await dbAddTrack(makeTrack('outside.mp3', 'outside!'))

		await dbAddPlaylist(1, [inside.id])

		const result = await downloadPlaylist(1)

		expect(result).toMatchObject({ total: 1, downloaded: 1 })
		expect(fetchCalls).toEqual(['music/inside.mp3'])
		expect(await getOfflineTrack(inside.uuid)).toBeDefined()
		expect(await getOfflineTrack(outside.uuid)).toBeUndefined()
	})
})
