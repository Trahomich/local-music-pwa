// Контракт: CONTRACTS.md §12 — resolveTrackFile с trackUuid для server трека:
// current offline запись играется без сети; stale + недоступная сеть → stale
// локальная копия как последняя доступная; нет записи → прежний server fetch;
// network failure при наличии записи → локальная копия; явный 404 не
// маскируется записью (not-found); local File источники не меняются.
import 'fake-indexeddb/auto'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAppDatabase } from '#lib/db/database.ts'
import { resolveTrackFile } from '#lib/helpers/file-resolver.ts'
import { clearDatabaseStores } from '#lib/helpers/test-helpers.ts'
import { SERVER_DIRECTORY_ID, type ServerFileEntity, type Track } from '#lib/library/types.ts'
import { saveOfflineTrack } from '#lib/offline/store.ts'
import {
	installServerLibraryMock,
	serverFileBody,
	serverFileDescriptor,
	serverFileMime,
} from '#lib/server-library/__tests__/server-library-mock.ts'

const mocks = vi.hoisted(() => ({ userId: null as string | null }))

vi.mock('#lib/auth/client.ts', () => ({
	bootstrapAuth: async () =>
		mocks.userId === null
			? { status: 'local-only' }
			: { status: 'authenticated', user: { id: Number(mocks.userId), username: 'user' } },
	getCurrentUserId: () => mocks.userId,
	registerAuthChangeHandler: () => () => {},
}))

const serverEntity = (path: string): ServerFileEntity => ({
	...serverFileDescriptor(path),
	kind: 'server',
})

const trackFor = (entity: ServerFileEntity): Track =>
	({
		uuid: `server:mock:${entity.path}`,
		directory: SERVER_DIRECTORY_ID,
		file: entity,
	}) as Track

// Blob из happy-dom не переживает structuredClone в fake-indexeddb;
// нативный node:buffer Blob — переживает.
const fullBlob = (path: string): Blob =>
	new NodeBlob([serverFileBody(path)], { type: serverFileMime(path) }) as unknown as Blob

// happy-dom File не умеет собираться из нативных Blob parts (size/text
// ломаются); в offline-кейсах подменяем File нативным — как в браузере.
const stubNativeFile = () => {
	vi.stubGlobal('File', NodeFile)
}

describe('resolveTrackFile с offline записью (CONTRACTS.md §12)', () => {
	let mock: ReturnType<typeof installServerLibraryMock>

	beforeEach(async () => {
		mocks.userId = null
		await closeAppDatabase()
		await clearDatabaseStores()
		mock = installServerLibraryMock()
	})

	afterEach(async () => {
		mocks.userId = null
		await closeAppDatabase()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('current offline запись играется без сети', async () => {
		const entity = serverEntity('Artist/Album/01 Song.mp3')
		await saveOfflineTrack(trackFor(entity), fullBlob(entity.path))
		stubNativeFile()

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
			trackUuid: `server:mock:${entity.path}`,
		})

		expect(result.status).toBe('loaded')
		if (result.status !== 'loaded') {
			return
		}

		expect(result.file.name).toBe(entity.name)
		expect(result.file.type).toBe('audio/mpeg')
		expect(result.file.lastModified).toBe(entity.lastModified)
		expect(await result.file.text()).toBe(serverFileBody(entity.path))
		expect(mock.requests).toHaveLength(0)
	})

	it('stale запись при недоступной сети играется как последняя доступная копия', async () => {
		const entity = serverEntity('stale.mp3')
		// У stale записи другие байты и размер: так видно, что взят именно она.
		const staleBody = 'old-stale-bytes'
		const staleEntity: ServerFileEntity = {
			...entity,
			size: staleBody.length,
			lastModified: 1,
		}
		const staleBlob = new NodeBlob([staleBody], {
			type: 'audio/mpeg',
		}) as unknown as Blob
		await saveOfflineTrack(trackFor(staleEntity), staleBlob)
		mock.state.networkError = true
		stubNativeFile()

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
			trackUuid: `server:mock:${entity.path}`,
		})

		expect(result.status).toBe('loaded')
		if (result.status !== 'loaded') {
			return
		}

		expect(await result.file.text()).toBe(staleBody)
		expect(result.file.lastModified).toBe(1)
	})

	it('stale запись при доступной сети даёт загруженный файл', async () => {
		const entity = serverEntity('stale-online.mp3')
		const staleEntity: ServerFileEntity = { ...entity, lastModified: 1 }
		await saveOfflineTrack(trackFor(staleEntity), fullBlob(entity.path))

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
			trackUuid: `server:mock:${entity.path}`,
		})

		// §12: обновление из сети — MAY; обязателен только успешный load.
		expect(result.status).toBe('loaded')
	})

	it('без offline записи остаётся прежний server fetch', async () => {
		const entity = serverEntity('plain.mp3')

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
			trackUuid: `server:mock:${entity.path}`,
		})

		expect(result.status).toBe('loaded')
		if (result.status !== 'loaded') {
			return
		}

		expect(await result.file.text()).toBe(serverFileBody(entity.path))
		expect(mock.requests).toHaveLength(1)
		expect(mock.requests[0]?.pathname).toBe('/api/server-library/file')
	})

	it('network failure без записи — error, как раньше', async () => {
		const entity = serverEntity('gone-offline.mp3')
		mock.state.networkError = true

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
			trackUuid: `server:mock:${entity.path}`,
		})

		expect(result.status).toBe('error')
	})

	it('network failure при current записи использует локальную копию', async () => {
		const entity = serverEntity('cached.mp3')
		await saveOfflineTrack(trackFor(entity), fullBlob(entity.path))
		mock.state.networkError = true
		stubNativeFile()

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
			trackUuid: `server:mock:${entity.path}`,
		})

		expect(result.status).toBe('loaded')
		if (result.status !== 'loaded') {
			return
		}

		expect(await result.file.text()).toBe(serverFileBody(entity.path))
	})

	it('явный 404 не маскируется offline записью: not-found', async () => {
		const entity = serverEntity('deleted-on-server.mp3')
		const staleEntity: ServerFileEntity = { ...entity, lastModified: 1 }
		await saveOfflineTrack(trackFor(staleEntity), fullBlob(entity.path))
		mock.state.fileStatuses[entity.path] = 404

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
			trackUuid: `server:mock:${entity.path}`,
		})

		expect(result.status).toBe('not-found')
	})

	it('без trackUuid поведение прежнее: даже с записью идёт в сеть', async () => {
		const entity = serverEntity('no-uuid.mp3')
		await saveOfflineTrack(trackFor(entity), fullBlob(entity.path))

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
		})

		expect(result.status).toBe('loaded')
		expect(mock.requests).toHaveLength(1)
	})

	it('local File источник не меняется: файл возвращается без сети и offline store', async () => {
		const localFile = new File(['local-bytes'], 'local.mp3', { type: 'audio/mpeg' })

		const result = await resolveTrackFile({
			directoryId: 1,
			entity: localFile,
			askPermission: false,
			trackUuid: 'local:whatever',
		})

		expect(result.status).toBe('loaded')
		if (result.status !== 'loaded') {
			return
		}

		expect(result.file).toBe(localFile)
		expect(mock.requests).toHaveLength(0)
	})
})
