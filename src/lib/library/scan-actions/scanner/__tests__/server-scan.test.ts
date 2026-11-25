// Контракт: CONTRACTS.md §5 — сканирование server source: identity [SERVER_DIRECTORY_ID, path],
// пропуск неизменённых, сохранение id/uuid при обновлении, удаление исчезнувших только после
// успешного полного списка, ошибки list/частичный сбой не удаляют прежние записи,
// локальные/legacy треки не затрагиваются, удаление источника — только IndexedDB.
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
	type ParsedTrackData,
	type PlaylistEntry,
	SERVER_DIRECTORY_ID,
	type Track,
	type UnknownTrack,
} from '#lib/library/types.ts'
import {
	installServerLibraryMock,
	serverFileDescriptor,
	serverFileMime,
} from '#lib/server-library/__tests__/server-library-mock.ts'

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

const FILE_EXTENSION_RE = /\.[^.]+$/

const parsedDataFor = (file: File): ParsedTrackData => ({
	name: file.name.replace(FILE_EXTENSION_RE, ''),
	album: 'Server Album',
	artists: ['Server Artist'],
	year: '2024',
	duration: 180,
	genre: [],
	trackNo: 1,
	trackOf: 1,
	discNo: 1,
	discOf: 1,
	metadataVersion: CURRENT_METADATA_VERSION,
	format: { codec: 'mp3' },
})

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

describe('server library scanning', () => {
	let mock: ReturnType<typeof installServerLibraryMock>

	beforeEach(async () => {
		await clearDatabaseStores()
		mock = installServerLibraryMock()
		mockedParseTrackMetadata.mockReset()
		mockedParseTrackMetadata.mockImplementation(async (file) => ({
			data: parsedDataFor(file),
		}))
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('imports every listed file under its full relative path', async () => {
		const files = [
			serverFileDescriptor('Artist/Album/01 Song.mp3'),
			serverFileDescriptor('Artist/Album/02 Song.flac'),
			serverFileDescriptor('Other/01 Song.mp3'),
		]
		mock.state.files = files

		await scanServer('server-directory-add')

		const tracks = await getServerTracks()
		expect(tracks).toHaveLength(3)

		for (const file of files) {
			const track = tracks.find((candidate) => candidate.fileName === file.path)
			expectToBeDefined(track)
			expect(track.directory).toBe(SERVER_DIRECTORY_ID)
			expect(track.file).toEqual({ ...file, kind: 'server' })
		}

		// Same basename in different folders stays a separate track.
		const duplicateNameTracks = tracks.filter(
			(track) =>
				track.fileName === 'Artist/Album/01 Song.mp3' ||
				track.fileName === 'Other/01 Song.mp3',
		)
		expect(duplicateNameTracks).toHaveLength(2)
		expect(new Set(duplicateNameTracks.map((track) => track.id)).size).toBe(2)

		// Each downloaded file reaches the existing import pipeline as a File with
		// basename, contract MIME type and mtime from the server descriptor.
		const parsedFiles = mockedParseTrackMetadata.mock.calls.map((call) => call[0])
		expect(parsedFiles).toHaveLength(3)
		for (const parsedFile of parsedFiles) {
			const text = await parsedFile.text()
			const path = text.slice('server-bytes:'.length)
			const descriptor = files.find((file) => file.path === path)
			expectToBeDefined(descriptor)
			expect(parsedFile.name).toBe(descriptor.name)
			expect(parsedFile.type).toBe(serverFileMime(path))
			expect(parsedFile.lastModified).toBe(descriptor.lastModified)
		}
	})

	it('uses only read-only GET requests against the documented endpoints', async () => {
		mock.state.files = [serverFileDescriptor('Artist/a.mp3')]

		await scanServer('server-directory-add')

		expect(mock.requests.length).toBeGreaterThan(0)
		for (const request of mock.requests) {
			expect(request.method).toBe('GET')
			expect(['/api/server-library/files', '/api/server-library/file']).toContain(
				request.pathname,
			)
		}
	})

	it('does not re-parse files whose size and mtime are unchanged', async () => {
		mock.state.files = [
			serverFileDescriptor('Artist/a.mp3'),
			serverFileDescriptor('Artist/b.mp3'),
		]
		await scanServer('server-directory-add')
		const idsBefore = (await getServerTracks()).map((track) => track.id).sort()

		mockedParseTrackMetadata.mockClear()
		await scanServer('server-directory-rescan')

		expect(mockedParseTrackMetadata).not.toHaveBeenCalled()
		const idsAfter = (await getServerTracks()).map((track) => track.id).sort()
		expect(idsAfter).toEqual(idsBefore)
	})

	it('re-parses changed files in place, keeping track id, uuid and references', async () => {
		const changedPath = 'Artist/a.mp3'
		mock.state.files = [serverFileDescriptor(changedPath), serverFileDescriptor('b.mp3')]
		await scanServer('server-directory-add')

		const trackBefore = await getServerTrackByPath(changedPath)

		const playlistId = await dbCreatePlaylist('Mix', '')
		const playlistEntry: Omit<PlaylistEntry, 'id'> = {
			playlistId,
			trackId: trackBefore.id,
			addedAt: Date.now(),
		}
		const db = await getDatabase()
		await db.add('playlistEntries', playlistEntry as PlaylistEntry)
		await dbAddToPlayHistory(trackBefore.id)

		const updatedDescriptor = serverFileDescriptor(changedPath, {
			size: 424_242,
			lastModified: 1_800_000_000_000,
		})
		mock.state.files = [updatedDescriptor, serverFileDescriptor('b.mp3')]
		mockedParseTrackMetadata.mockClear()

		await scanServer('server-directory-rescan')

		expect(mockedParseTrackMetadata).toHaveBeenCalledTimes(1)
		const trackAfter = await getServerTrackByPath(changedPath)
		expect(trackAfter.id).toBe(trackBefore.id)
		expect(trackAfter.uuid).toBe(trackBefore.uuid)
		expect(trackAfter.file).toEqual({ ...updatedDescriptor, kind: 'server' })

		const entries = await db.getAll('playlistEntries')
		expect(entries).toHaveLength(1)
		expect(entries[0]?.trackId).toBe(trackBefore.id)
		const history = await db.getAll('playHistory')
		expect(history).toHaveLength(1)
		expect(history[0]?.trackId).toBe(trackBefore.id)
	})

	it('removes server tracks that vanished from a successful full listing', async () => {
		mock.state.files = [
			serverFileDescriptor('Artist/a.mp3'),
			serverFileDescriptor('Artist/b.mp3'),
		]
		await scanServer('server-directory-add')
		const localTrackId = await dbImportTestTrack()
		const legacyTrackId = await dbImportTestTrack({
			directory: LEGACY_NO_NATIVE_DIRECTORY,
			fileName: 'legacy.mp3',
			file: new File(['legacy'], 'legacy.mp3', { type: 'audio/mpeg' }),
		})

		mock.state.files = [serverFileDescriptor('Artist/a.mp3')]
		await scanServer('server-directory-rescan')

		const serverTracks = await getServerTracks()
		expect(serverTracks).toHaveLength(1)
		expect(serverTracks[0]?.fileName).toBe('Artist/a.mp3')

		const db = await getDatabase()
		expect(await db.get('tracks', localTrackId)).toBeDefined()
		expect(await db.get('tracks', legacyTrackId)).toBeDefined()
	})

	it('empties the server source when a successful listing returns no files', async () => {
		mock.state.files = [
			serverFileDescriptor('Artist/a.mp3'),
			serverFileDescriptor('Artist/b.mp3'),
		]
		await scanServer('server-directory-add')
		const localTrackId = await dbImportTestTrack()

		mock.state.files = []
		await scanServer('server-directory-rescan')

		await dbGetAllAndExpectLength('tracks', 1)
		const db = await getDatabase()
		expect(await db.get('tracks', localTrackId)).toBeDefined()
	})

	it('keeps previous tracks and reports the error when the listing request fails', async () => {
		mock.state.files = [
			serverFileDescriptor('Artist/a.mp3'),
			serverFileDescriptor('Artist/b.mp3'),
		]
		await scanServer('server-directory-add')
		const idsBefore = (await getServerTracks()).map((track) => track.id).sort()

		mock.state.listStatus = 503
		await expect(scanServer('server-directory-rescan')).rejects.toThrow()

		const idsAfter = (await getServerTracks()).map((track) => track.id).sort()
		expect(idsAfter).toEqual(idsBefore)
	})

	it('keeps previous tracks when individual downloads fail mid-scan', async () => {
		const pathA = 'Artist/a.mp3'
		const pathB = 'Artist/b.mp3'
		mock.state.files = [serverFileDescriptor(pathA), serverFileDescriptor(pathB)]
		await scanServer('server-directory-add')

		const trackA = await getServerTrackByPath(pathA)
		const playlistId = await dbCreatePlaylist('Mix', '')
		const playlistEntry: Omit<PlaylistEntry, 'id'> = {
			playlistId,
			trackId: trackA.id,
			addedAt: Date.now(),
		}
		const db = await getDatabase()
		await db.add('playlistEntries', playlistEntry as PlaylistEntry)

		// `a` changed on the server but its download breaks; `b` is unchanged.
		mock.state.files = [
			serverFileDescriptor(pathA, { size: 999_999, lastModified: 1_800_000_000_000 }),
			serverFileDescriptor(pathB),
		]
		mock.state.fileStatuses[pathA] = 500
		await scanServer('server-directory-rescan')

		// CONTRACTS.md §5: only paths missing from a successful full listing are removed,
		// so the previous records survive a partial failure.
		const fileNames = (await getServerTracks()).map((track) => track.fileName).sort()
		expect(fileNames).toEqual([pathA, pathB].sort())
		await dbGetAllAndExpectLength('playlistEntries', 1)
	})

	it('removing the server source clears only its own records and makes no HTTP calls', async () => {
		mock.state.files = [
			serverFileDescriptor('Artist/a.mp3'),
			serverFileDescriptor('Artist/b.mp3'),
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
