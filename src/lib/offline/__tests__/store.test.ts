// Контракт: CONTRACTS.md §12 — offline store: IndexedDB schema v5 со store
// `offlineTracks` (key `trackUuid`); запись {trackUuid, fileName, size,
// lastModified, downloadedAt, blob}; current = совпадение size+lastModified с
// ServerFileEntity; все writes dispatch DatabaseChangedEvent; truncated blob
// и ошибки quota/abort не сохраняются; записи живут в per-user БД (§9) и не
// смешиваются между аккаунтами и anonymous.
import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAppDatabase, getDatabase } from '#lib/db/database.ts'
import { type DatabaseChangeDetails, onDatabaseChange } from '#lib/db/events.ts'
import { clearDatabaseStores } from '#lib/helpers/test-helpers.ts'
import { SERVER_DIRECTORY_ID, type Track } from '#lib/library/types.ts'
import {
	getOfflineTrack,
	isOfflineTrackCurrent,
	listOfflineTrackUuids,
	removeOfflineTrack,
	saveOfflineTrack,
} from '#lib/offline/store.ts'
import {
	serverFileBody,
	serverFileDescriptor,
	serverFileMime,
} from '#lib/server-library/__tests__/server-library-mock.ts'

const SERVER_ERROR_PATTERN = /server/i
const QUOTA_ERROR_PATTERN = /quota/i

const mocks = vi.hoisted(() => ({ userId: null as string | null }))

vi.mock('#lib/auth/client.ts', () => ({
	bootstrapAuth: async () =>
		mocks.userId === null
			? { status: 'local-only' }
			: { status: 'authenticated', user: { id: Number(mocks.userId), username: 'user' } },
	getCurrentUserId: () => mocks.userId,
	registerAuthChangeHandler: () => () => {},
}))

const serverTrack = (path: string): Track => {
	const descriptor = serverFileDescriptor(path)

	return {
		uuid: `server:mock:${path}`,
		directory: SERVER_DIRECTORY_ID,
		file: { ...descriptor, kind: 'server' },
	} as Track
}

// Blob из happy-dom не переживает structuredClone в fake-indexeddb (теряет
// size/type/text после roundtrip); нативный node:buffer Blob — переживает.
const fullBlob = (path: string): Blob =>
	new NodeBlob([serverFileBody(path)], { type: serverFileMime(path) }) as unknown as Blob

const events: DatabaseChangeDetails[] = []
let unsubscribeEvents: (() => void) | null = null

const offlineTrackEvents = () => events.filter((change) => change.storeName === 'offlineTracks')

beforeEach(async () => {
	mocks.userId = null
	await closeAppDatabase()
	await clearDatabaseStores()
	events.length = 0
	unsubscribeEvents = onDatabaseChange((changes) => {
		events.push(...changes)
	})
})

afterEach(async () => {
	unsubscribeEvents?.()
	unsubscribeEvents = null
	mocks.userId = null
	await closeAppDatabase()
	vi.restoreAllMocks()
})

describe('offline store (CONTRACTS.md §12)', () => {
	it('открывает IndexedDB schema v5 со store offlineTracks', async () => {
		const db = await getDatabase()

		expect(db.version).toBe(5)
		expect([...db.objectStoreNames]).toContain('offlineTracks')
	})

	it('сохраняет полную запись с MIME и возвращает её по trackUuid', async () => {
		const path = 'Artist/Album/01 Song.flac'
		const track = serverTrack(path)
		const blob = fullBlob(path)

		const record = await saveOfflineTrack(track, blob)

		expect(record.trackUuid).toBe(track.uuid)
		expect(record.fileName).toBe('01 Song.flac')
		expect(record.size).toBe(blob.size)
		expect(record.lastModified).toBe(1_764_057_600_000)
		expect(typeof record.downloadedAt).toBe('number')
		expect(record.blob.type).toBe('audio/flac')

		const loaded = await getOfflineTrack(track.uuid)
		expect(loaded).toBeDefined()
		expect(loaded?.trackUuid).toBe(track.uuid)
		expect(await loaded?.blob.text()).toBe(serverFileBody(path))

		expect(await listOfflineTrackUuids()).toEqual([track.uuid])
	})

	it('возвращает undefined для отсутствующей записи', async () => {
		expect(await getOfflineTrack('server:mock:missing.mp3')).toBeUndefined()
	})

	it('dispatch-ит add при первом сохранении и update при повторном', async () => {
		const path = 'a.mp3'
		const track = serverTrack(path)

		await saveOfflineTrack(track, fullBlob(path))
		expect(offlineTrackEvents()).toEqual([
			{ storeName: 'offlineTracks', operation: 'add', key: track.uuid },
		])

		events.length = 0
		await saveOfflineTrack(track, fullBlob(path))
		expect(offlineTrackEvents()).toEqual([
			{ storeName: 'offlineTracks', operation: 'update', key: track.uuid },
		])
	})

	it('removeOfflineTrack удаляет запись и dispatch-ит delete; для отсутствующей — молча', async () => {
		const path = 'b.mp3'
		const track = serverTrack(path)
		await saveOfflineTrack(track, fullBlob(path))

		events.length = 0
		await removeOfflineTrack(track.uuid)

		expect(await getOfflineTrack(track.uuid)).toBeUndefined()
		expect(await listOfflineTrackUuids()).toEqual([])
		expect(offlineTrackEvents()).toEqual([
			{ storeName: 'offlineTracks', operation: 'delete', key: track.uuid },
		])

		events.length = 0
		await removeOfflineTrack(track.uuid)
		expect(offlineTrackEvents()).toEqual([])
	})

	it('isOfflineTrackCurrent истинно только при совпадении size и lastModified', async () => {
		const path = 'c.mp3'
		const track = serverTrack(path)
		const record = await saveOfflineTrack(track, fullBlob(path))

		expect(isOfflineTrackCurrent(record, track)).toBe(true)

		const changedSize = {
			...track,
			file: { ...(track.file as object), size: record.size + 1, kind: 'server' },
		} as Track
		expect(isOfflineTrackCurrent(record, changedSize)).toBe(false)

		const changedMtime = {
			...track,
			file: {
				...(track.file as object),
				lastModified: record.lastModified - 1,
				kind: 'server',
			},
		} as Track
		expect(isOfflineTrackCurrent(record, changedMtime)).toBe(false)

		const localTrack = {
			uuid: 'local:1',
			directory: 1,
			file: new File(['x'], 'x.mp3'),
		} as Track
		expect(isOfflineTrackCurrent(record, localTrack)).toBe(false)
	})

	it('отклоняет truncated blob и ничего не сохраняет', async () => {
		const path = 'd.mp3'
		const track = serverTrack(path)

		await expect(saveOfflineTrack(track, new Blob(['short']))).rejects.toThrow()
		expect(await getOfflineTrack(track.uuid)).toBeUndefined()
		expect(offlineTrackEvents()).toEqual([])
	})

	it('отклоняет local File трек: скачивать нечего', async () => {
		const localTrack = {
			uuid: 'local:2',
			directory: 1,
			file: new File(['x'], 'x.mp3'),
		} as Track

		await expect(saveOfflineTrack(localTrack, new Blob(['x']))).rejects.toThrow(
			SERVER_ERROR_PATTERN,
		)
		expect(await listOfflineTrackUuids()).toEqual([])
	})

	it('пропагирует ошибку quota из IndexedDB и не оставляет partial записи', async () => {
		const path = 'e.mp3'
		const track = serverTrack(path)

		vi.spyOn(IDBObjectStore.prototype, 'put').mockRejectedValueOnce(
			new DOMException('quota exceeded', 'QuotaExceededError'),
		)

		await expect(saveOfflineTrack(track, fullBlob(path))).rejects.toThrow(QUOTA_ERROR_PATTERN)
		expect(await getOfflineTrack(track.uuid)).toBeUndefined()
		expect(await listOfflineTrackUuids()).toEqual([])
	})

	it('изолирует записи по per-user БД: аккаунты и anonymous не смешиваются (§9)', async () => {
		mocks.userId = 'user-a'
		await clearDatabaseStores()
		const trackA = serverTrack('a.mp3')
		await saveOfflineTrack(trackA, fullBlob('a.mp3'))
		expect(await listOfflineTrackUuids()).toEqual([trackA.uuid])

		mocks.userId = 'user-b'
		await clearDatabaseStores()
		expect(await listOfflineTrackUuids()).toEqual([])
		const trackB = serverTrack('b.mp3')
		await saveOfflineTrack(trackB, fullBlob('b.mp3'))

		mocks.userId = 'user-a'
		expect(await listOfflineTrackUuids()).toEqual([trackA.uuid])
		expect(await getOfflineTrack(trackB.uuid)).toBeUndefined()

		mocks.userId = null
		await clearDatabaseStores()
		expect(await listOfflineTrackUuids()).toEqual([])
	})
})
