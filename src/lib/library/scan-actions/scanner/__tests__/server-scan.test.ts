// Контракт: CONTRACTS.md §10 — каталожное сканирование server source: identity
// [SERVER_DIRECTORY_ID, path], stable server uuid, пропуск неизменённых, сохранение
// numeric id при обновлении и миграции uuid, удаление исчезнувших только после
// успешного полного catalog, ошибка catalog/частичный сбой не удаляют прежние записи,
// аудио не скачивается и browser tag parser не вызывается, artwork качается по hash
// один раз, local/legacy треки не затрагиваются, 401 — auth-ошибка без очистки библиотеки.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '#lib/db/database.ts'
import {
	clearDatabaseStores,
	dbGetAllAndExpectLength,
	expectToBeDefined,
} from '#lib/helpers/test-helpers.ts'
import { dbAddToPlayHistory } from '#lib/library/play-history-actions.ts'
import { dbCreatePlaylist } from '#lib/library/playlists-actions.ts'
import { removeDirectory } from '#lib/library/scan-actions/directories.ts'
import { workerAction } from '#lib/library/scan-actions/scanner/actions.ts'
import { dbImportTrack } from '#lib/library/scan-actions/scanner/steps/import-track.ts'
import { parseTrackMetadata } from '#lib/library/scan-actions/scanner/steps/parse-track-metadata.ts'
import {
	CURRENT_METADATA_VERSION,
	type Directory,
	LEGACY_NO_NATIVE_DIRECTORY,
	type PlaylistEntry,
	SERVER_DIRECTORY_ID,
	type Track,
	type UnknownTrack,
} from '#lib/library/types.ts'
import {
	installServerLibraryMock,
	SERVER_ARTWORK_HASH,
	serverCatalogArtwork,
	serverCatalogTrack,
	serverFileDescriptor,
} from '#lib/server-library/__tests__/server-library-mock.ts'
import { ServerLibraryRequestError } from '#lib/server-library/client.ts'

vi.mock('#lib/library/scan-actions/scanner/steps/parse-track-metadata.ts', () => ({
	parseTrackMetadata: vi.fn(),
}))

vi.mock('#lib/components/snackbar/snackbar.ts', () => ({
	snackbar: Object.assign(vi.fn(), {
		unexpectedError: vi.fn(),
		dismiss: vi.fn(),
	}),
}))

vi.mock('#lib/db/lock-database.ts', () => ({
	lockDatabase: <T>(action: () => Promise<T>): Promise<T> => action(),
	isDatabaseOperationPending: () => false,
}))

const mockedParseTrackMetadata = vi.mocked(parseTrackMetadata)

const stableUuid = (path: string): string => `server:mock:${path}`

const FILE_EXTENSION_RE = /\.[^.]+$/

const dbImportTestTrack = (overrides: Partial<UnknownTrack> = {}): Promise<number> =>
	dbImportTrack(
		{
			uuid: crypto.randomUUID(),
			name: 'Local Track',
			album: 'Local Album',
			artists: ['Local Artist'],
			year: '2020',
			duration: 100,
			trackNo: 1,
			trackOf: 1,
			discNo: 1,
			discOf: 1,
			genre: [],
			file: new File(['local'], 'local.mp3', { type: 'audio/mpeg' }),
			scannedAt: Date.now(),
			fileName: 'local.mp3',
			directory: 1,
			...overrides,
		},
		undefined,
	)

const getServerTracks = async (): Promise<Track[]> => {
	const db = await getDatabase()
	return db.getAllFromIndex('tracks', 'directory', SERVER_DIRECTORY_ID)
}

const getServerTrackByPath = async (path: string): Promise<Track> => {
	const track = (await getServerTracks()).find((candidate) => candidate.fileName === path)
	expectToBeDefined(track)
	return track
}

const scanServer = (action: 'server-directory-add' | 'server-directory-rescan'): Promise<void> =>
	workerAction({ action, dirId: SERVER_DIRECTORY_ID })

const artworkRequests = (
	requests: ReadonlyArray<{ pathname: string }>,
): Array<{ pathname: string }> =>
	requests.filter((request) => request.pathname.startsWith('/api/server-library/artwork/'))

describe('server library catalog scanning', () => {
	let mock: ReturnType<typeof installServerLibraryMock>

	beforeEach(async () => {
		await clearDatabaseStores()
		mock = installServerLibraryMock()
		mockedParseTrackMetadata.mockReset()
		// CONTRACTS.md §10: browser tag parsing is forbidden on the server path —
		// any accidental call must fail the test loudly.
		mockedParseTrackMetadata.mockImplementation(() => {
			throw new Error('parseTrackMetadata must not run for server scans')
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('imports every catalog track under its full relative path without downloading audio or parsing tags', async () => {
		const descriptors = [
			serverFileDescriptor('Artist/Album/01 Song.mp3'),
			serverFileDescriptor('Artist/Album/02 Song.flac'),
			serverFileDescriptor('Other/01 Song.mp3'),
		]
		mock.state.catalogTracks = descriptors.map((descriptor) => serverCatalogTrack(descriptor))

		await scanServer('server-directory-add')

		const tracks = await getServerTracks()
		expect(tracks).toHaveLength(3)

		for (const descriptor of descriptors) {
			const track = tracks.find((candidate) => candidate.fileName === descriptor.path)
			expectToBeDefined(track)
			expect(track.directory).toBe(SERVER_DIRECTORY_ID)
			expect(track.file).toEqual({ ...descriptor, kind: 'server' })
			expect(track.uuid).toBe(stableUuid(descriptor.path))
			expect(track.metadataVersion).toBe(CURRENT_METADATA_VERSION)
			expect(track.name).toBe(descriptor.name.replace(FILE_EXTENSION_RE, ''))
		}

		// Same basename in different folders stays a separate track.
		const duplicateNameTracks = tracks.filter(
			(track) =>
				track.fileName === 'Artist/Album/01 Song.mp3' ||
				track.fileName === 'Other/01 Song.mp3',
		)
		expect(duplicateNameTracks).toHaveLength(2)
		expect(new Set(tracks.map((track) => track.id)).size).toBe(3)

		expect(mockedParseTrackMetadata).not.toHaveBeenCalled()
		expect(mock.requests).toEqual([
			expect.objectContaining({ method: 'GET', pathname: '/api/server-library/catalog' }),
		])
	})

	it('rescan polls the server scan and keeps unchanged tracks without artwork or audio downloads', async () => {
		const descriptors = [
			serverFileDescriptor('Artist/a.mp3'),
			serverFileDescriptor('Artist/b.mp3'),
		]
		mock.state.catalogTracks = descriptors.map((descriptor) => serverCatalogTrack(descriptor))
		await scanServer('server-directory-add')
		const idsBefore = (await getServerTracks()).map((track) => track.id).sort()

		mock.requests.length = 0
		await scanServer('server-directory-rescan')

		expect(mock.requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
			'POST /api/server-library/rescan',
			'GET /api/server-library/status',
			'GET /api/server-library/catalog',
		])
		expect(mockedParseTrackMetadata).not.toHaveBeenCalled()
		expect(artworkRequests(mock.requests)).toHaveLength(0)

		const idsAfter = (await getServerTracks()).map((track) => track.id).sort()
		expect(idsAfter).toEqual(idsBefore)
	})

	it('re-imports changed catalog entries in place, keeping numeric id, stable uuid and references', async () => {
		const pathA = 'Artist/a.mp3'
		const v1 = [serverFileDescriptor(pathA), serverFileDescriptor('Artist/b.mp3')]
		mock.state.catalogTracks = v1.map((descriptor) => serverCatalogTrack(descriptor))
		await scanServer('server-directory-add')
		const trackBefore = await getServerTrackByPath(pathA)

		const playlistId = await dbCreatePlaylist('Mix', '')
		const playlistEntry: Omit<PlaylistEntry, 'id'> = {
			playlistId,
			trackId: trackBefore.id,
			addedAt: Date.now(),
		}
		const db = await getDatabase()
		await db.add('playlistEntries', playlistEntry as PlaylistEntry)
		await dbAddToPlayHistory(trackBefore.id)

		const v2 = [
			serverFileDescriptor(pathA, { size: 424_242, lastModified: 1_800_000_000_000 }),
			serverFileDescriptor('Artist/b.mp3'),
		]
		mock.state.catalogTracks = v2.map((descriptor) => serverCatalogTrack(descriptor))

		await scanServer('server-directory-rescan')

		const trackAfter = await getServerTrackByPath(pathA)
		expect(trackAfter.id).toBe(trackBefore.id)
		expect(trackAfter.uuid).toBe(stableUuid(pathA))
		expect(trackAfter.file).toEqual({ ...v2[0], kind: 'server' })

		const entries = await db.getAll('playlistEntries')
		expect(entries).toHaveLength(1)
		expect(entries[0]?.trackId).toBe(trackBefore.id)
		const history = await db.getAll('playHistory')
		expect(history).toHaveLength(1)
		expect(history[0]?.trackId).toBe(trackBefore.id)
	})

	it('migrates download-era tracks with random uuids to the stable server uuid in place', async () => {
		const descriptor = serverFileDescriptor('Artist/legacy.mp3')
		const legacyUuid = crypto.randomUUID()
		const legacyId = await dbImportTrack(
			{
				uuid: legacyUuid,
				name: 'Legacy',
				album: 'Legacy Album',
				artists: ['Legacy Artist'],
				year: '2019',
				duration: 60,
				trackNo: 1,
				trackOf: 1,
				discNo: 1,
				discOf: 1,
				genre: [],
				file: { kind: 'server', ...descriptor },
				scannedAt: Date.now(),
				fileName: descriptor.path,
				directory: SERVER_DIRECTORY_ID,
				metadataVersion: CURRENT_METADATA_VERSION,
			},
			undefined,
		)

		mock.state.catalogTracks = [serverCatalogTrack(descriptor)]
		await scanServer('server-directory-add')

		const track = await getServerTrackByPath(descriptor.path)
		expect(track.id).toBe(legacyId)
		expect(track.uuid).toBe(stableUuid(descriptor.path))
		expect(track.fileName).toBe(descriptor.path)
	})

	it('downloads each artwork hash once per import and reuses the IndexedDB record across rescans', async () => {
		const artwork = serverCatalogArtwork()
		mock.state.artworkBodies = { [artwork.hash]: 'fake-artwork-bytes' }
		const v1 = [serverFileDescriptor('Artist/a.mp3'), serverFileDescriptor('Artist/b.mp3')]
		mock.state.catalogTracks = v1.map((descriptor) =>
			serverCatalogTrack(descriptor, { artwork }),
		)

		await scanServer('server-directory-add')

		const db = await getDatabase()
		const imageRecord = await db.get('images', artwork.hash)
		expectToBeDefined(imageRecord)
		expect(imageRecord.hash).toBe(artwork.hash)
		expect(artworkRequests(mock.requests)).toHaveLength(1)

		// Both files changed on the server: they re-import, the artwork does not re-download.
		mock.requests.length = 0
		mock.state.catalogTracks = v1.map((descriptor) =>
			serverCatalogTrack(
				serverFileDescriptor(descriptor.path, { size: descriptor.size + 1 }),
				{
					artwork,
				},
			),
		)
		await scanServer('server-directory-rescan')

		expect(artworkRequests(mock.requests)).toHaveLength(0)
		const imageRecordAfter = await db.get('images', artwork.hash)
		expectToBeDefined(imageRecordAfter)
	})

	it('removes server tracks that vanished from a successful full catalog', async () => {
		mock.state.catalogTracks = [
			serverCatalogTrack(serverFileDescriptor('Artist/a.mp3')),
			serverCatalogTrack(serverFileDescriptor('Artist/b.mp3')),
		]
		await scanServer('server-directory-add')
		const localTrackId = await dbImportTestTrack()
		const legacyTrackId = await dbImportTestTrack({
			directory: LEGACY_NO_NATIVE_DIRECTORY,
			fileName: 'legacy.mp3',
			file: new File(['legacy'], 'legacy.mp3', { type: 'audio/mpeg' }),
		})

		mock.state.catalogTracks = [serverCatalogTrack(serverFileDescriptor('Artist/a.mp3'))]
		await scanServer('server-directory-rescan')

		const serverTracks = await getServerTracks()
		expect(serverTracks).toHaveLength(1)
		expect(serverTracks[0]?.fileName).toBe('Artist/a.mp3')

		const db = await getDatabase()
		expect(await db.get('tracks', localTrackId)).toBeDefined()
		expect(await db.get('tracks', legacyTrackId)).toBeDefined()
	})

	it('empties the server source when a successful catalog returns no tracks', async () => {
		mock.state.catalogTracks = [
			serverCatalogTrack(serverFileDescriptor('Artist/a.mp3')),
			serverCatalogTrack(serverFileDescriptor('Artist/b.mp3')),
		]
		await scanServer('server-directory-add')
		const localTrackId = await dbImportTestTrack()

		mock.state.catalogTracks = []
		await scanServer('server-directory-rescan')

		await dbGetAllAndExpectLength('tracks', 1)
		const db = await getDatabase()
		expect(await db.get('tracks', localTrackId)).toBeDefined()
	})

	it('keeps previous tracks and reports the error when the catalog request fails', async () => {
		mock.state.catalogTracks = [
			serverCatalogTrack(serverFileDescriptor('Artist/a.mp3')),
			serverCatalogTrack(serverFileDescriptor('Artist/b.mp3')),
		]
		await scanServer('server-directory-add')
		const idsBefore = (await getServerTracks()).map((track) => track.id).sort()

		mock.state.catalogStatuses = [503]
		await expect(scanServer('server-directory-rescan')).rejects.toThrow()

		const idsAfter = (await getServerTracks()).map((track) => track.id).sort()
		expect(idsAfter).toEqual(idsBefore)
	})

	it('waits for the server scan when the first catalog is not ready (409), then imports', async () => {
		mock.state.catalogStatuses = [409, 200]
		mock.state.scanStatuses = [
			{ enabled: true, state: 'scanning', current: 1, total: 3 },
			{ enabled: true, state: 'ready', current: 3, total: 3 },
		]
		mock.state.catalogTracks = [serverCatalogTrack(serverFileDescriptor('Artist/a.mp3'))]

		await scanServer('server-directory-add')

		const tracks = await getServerTracks()
		expect(tracks).toHaveLength(1)
		expect(tracks[0]?.fileName).toBe('Artist/a.mp3')
		expect(
			mock.requests.some((request) => request.pathname === '/api/server-library/status'),
		).toBe(true)
		expect(
			mock.requests.filter((request) => request.pathname === '/api/server-library/catalog'),
		).toHaveLength(2)
		expect(mockedParseTrackMetadata).not.toHaveBeenCalled()
	})

	it('keeps previous records when an artwork download fails mid-scan', async () => {
		const pathA = 'Artist/a.mp3'
		const pathB = 'Artist/b.mp3'
		mock.state.catalogTracks = [
			serverCatalogTrack(serverFileDescriptor(pathA)),
			serverCatalogTrack(serverFileDescriptor(pathB)),
		]
		await scanServer('server-directory-add')

		// `a` changed on the server and now declares artwork the server cannot
		// serve; `b` is unchanged. The artwork hash is absent from artworkBodies,
		// so the download 404s and the track keeps its previous record.
		mock.state.catalogTracks = [
			serverCatalogTrack(
				serverFileDescriptor(pathA, { size: 999_999, lastModified: 1_800_000_000_000 }),
				{
					artwork: serverCatalogArtwork(),
				},
			),
			serverCatalogTrack(serverFileDescriptor(pathB)),
		]
		await scanServer('server-directory-rescan')

		// CONTRACTS.md §10: only paths missing from a successful full catalog are removed,
		// so the previous records survive a partial failure.
		const fileNames = (await getServerTracks()).map((track) => track.fileName).sort()
		expect(fileNames).toEqual([pathA, pathB].sort())
		expect(SERVER_ARTWORK_HASH.length).toBe(64)
	})

	it('reports a 401 from the server library as an auth error and keeps the library untouched', async () => {
		mock.state.catalogStatuses = [401]

		const failure = await scanServer('server-directory-add').then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe('AUTH_REQUIRED')
		await dbGetAllAndExpectLength('tracks', 0)
	})

	it('removing the server source clears only its own records and makes no HTTP calls', async () => {
		mock.state.catalogTracks = [
			serverCatalogTrack(serverFileDescriptor('Artist/a.mp3')),
			serverCatalogTrack(serverFileDescriptor('Artist/b.mp3')),
		]
		await scanServer('server-directory-add')
		const localTrackId = await dbImportTestTrack()

		const db = await getDatabase()
		const serverTrack = await getServerTrackByPath('Artist/a.mp3')
		const playlistId = await dbCreatePlaylist('Mix', '')
		const playlistEntry: Omit<PlaylistEntry, 'id'> = {
			playlistId,
			trackId: serverTrack.id,
			addedAt: Date.now(),
		}
		await db.add('playlistEntries', playlistEntry as PlaylistEntry)
		await db.put('directories', { id: 1, handle: {} } as Directory)
		await db.put('directories', { id: SERVER_DIRECTORY_ID, kind: 'server' } as Directory)

		const requestsBefore = mock.requests.length
		await removeDirectory(SERVER_DIRECTORY_ID)

		await dbGetAllAndExpectLength('tracks', 1)
		expect(await db.get('tracks', localTrackId)).toBeDefined()
		expect(await db.get('directories', SERVER_DIRECTORY_ID)).toBeUndefined()
		expect(await db.get('directories', 1)).toBeDefined()
		await dbGetAllAndExpectLength('playlistEntries', 0)
		expect(mock.requests.length).toBe(requestsBefore)
	})
})
