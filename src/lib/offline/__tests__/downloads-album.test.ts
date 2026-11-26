// Контракт: CONTRACTS.md §12 (album download + ActiveBatchInfo) — независимые
// проверки #40 к реализации #39 (автор тестов не трогает downloads.ts):
// downloadAlbum(albumId) скачивает ТОЛЬКО треки своего альбома через
// tracks.index('album'), mixed local/current/stale/failed считаются как у
// playlist, concurrency 2, cancel не оставляет partial, повторный вызов не
// запускает дубликат; ActiveBatchInfo несёт albumId/label/currentTrackName
// и живой done/total, playlist-путь не сломан.
import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '#lib/db/database.ts'
import { clearDatabaseStores, expectToBeDefined } from '#lib/helpers/test-helpers.ts'
import { SERVER_DIRECTORY_ID, type Track } from '#lib/library/types.ts'
import {
	type ActiveBatchInfo,
	cancelDownloads,
	downloadAlbum,
	downloadPlaylist,
	getActiveBatch,
	subscribeDownloads,
} from '../downloads.ts'
import { getOfflineTrack, saveOfflineTrack } from '../store.ts'

// ---------------------------------------------------------------------------
// In-memory server + fetch stub with concurrency stats and an abortable gate
// (тот же подход, что в downloads.test.ts/downloads-contract.test.ts).
// ---------------------------------------------------------------------------

const serverFiles = new Map<string, string>()

interface FetchStats {
	calls: string[]
	active: number
	maxActive: number
}

let fetchStats: FetchStats
let gateReleases: (() => void)[] | null = null

const waitForGate = (signal: AbortSignal | null | undefined): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			reject(new DOMException('The operation was aborted', 'AbortError'))
		}
		signal?.addEventListener('abort', onAbort, { once: true })

		gateReleases?.push(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		})
	})

const stubFetch = () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input.toString()
			const path = new URL(url, 'http://localhost').searchParams.get('path')
			if (path === null) {
				throw new Error(`Unexpected fetch without a path parameter: ${url}`)
			}
			fetchStats.calls.push(path)

			fetchStats.active += 1
			fetchStats.maxActive = Math.max(fetchStats.maxActive, fetchStats.active)

			try {
				init?.signal?.throwIfAborted()
				if (gateReleases) {
					await waitForGate(init?.signal)
				} else {
					await new Promise((resolve) => {
						setTimeout(resolve, 0)
					})
				}
				init?.signal?.throwIfAborted()

				const content = serverFiles.get(path)
				if (content === undefined) {
					return { ok: false, status: 404, blob: async () => new Blob() } as Response
				}

				return {
					ok: true,
					status: 200,
					blob: async () =>
						new NodeBlob([content], { type: 'audio/mpeg' }) as unknown as Blob,
				} as Response
			} finally {
				fetchStats.active -= 1
			}
		}),
	)
}

const releaseFetchGate = () => {
	const releases = gateReleases
	gateReleases = null
	for (const release of releases ?? []) {
		release()
	}
}

// ---------------------------------------------------------------------------
// Fixtures: альбомы в store 'albums', треки с album=<имя альбома>.
// ---------------------------------------------------------------------------

let trackCounter = 0

interface TestTrackOptions {
	albumName: string
	/** null → local File track (never downloaded). */
	serverContent: string | null
	lastModified?: number
}

const makeTrack = (options: TestTrackOptions): Track => {
	trackCounter += 1
	const id = trackCounter
	const fileName = `music/album-track-${id}.mp3`
	const content = options.serverContent

	if (content !== null) {
		serverFiles.set(fileName, content)
	}

	const file: Track['file'] =
		content === null
			? new File(['local'], `album-track-${id}.mp3`, { type: 'audio/mpeg' })
			: {
					kind: 'server',
					path: fileName,
					name: `album-track-${id}.mp3`,
					size: content.length,
					lastModified: options.lastModified ?? 1000,
				}

	return {
		id,
		uuid: `server:album-test-track-${id}`,
		name: `Album Track ${id}`,
		album: options.albumName,
		artists: ['Album Artist'],
		year: '2024',
		duration: 180,
		genre: [],
		trackNo: id,
		trackOf: 1,
		discNo: 1,
		discOf: 1,
		file,
		scannedAt: 1000,
		fileName,
		directory: content === null ? 1 : SERVER_DIRECTORY_ID,
	}
}

const dbAddTrack = async (track: Track): Promise<Track> => {
	const db = await getDatabase()
	await db.put('tracks', track)

	return track
}

const dbAddAlbum = async (id: number, name: string): Promise<void> => {
	const db = await getDatabase()
	await db.put('albums', {
		id,
		uuid: `album-uuid-${id}`,
		name,
		artists: ['Album Artist'],
		year: '2024',
	})
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

// ---------------------------------------------------------------------------

describe('downloadAlbum (независимые контрактные проверки #40, CONTRACTS.md §12)', () => {
	beforeEach(async () => {
		await clearDatabaseStores()
		serverFiles.clear()
		fetchStats = { calls: [], active: 0, maxActive: 0 }
		gateReleases = null
		trackCounter = 0
		stubFetch()
	})

	afterEach(() => {
		releaseFetchGate()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('скачивает только треки своего альбома; треки других альбомов не затрагиваются', async () => {
		await dbAddAlbum(1, 'Alpha Album')
		await dbAddAlbum(2, 'Beta Album')
		const alphaOne = await dbAddTrack(
			makeTrack({ albumName: 'Alpha Album', serverContent: 'alpha-1!!!' }),
		)
		const alphaTwo = await dbAddTrack(
			makeTrack({ albumName: 'Alpha Album', serverContent: 'alpha-2!!!' }),
		)
		const betaOne = await dbAddTrack(
			makeTrack({ albumName: 'Beta Album', serverContent: 'beta-1!!!!' }),
		)
		const betaTwo = await dbAddTrack(
			makeTrack({ albumName: 'Beta Album', serverContent: 'beta-2!!!!' }),
		)

		const result = await downloadAlbum(1)

		expect(result).toEqual({
			total: 2,
			downloaded: 2,
			current: 0,
			skippedLocal: 0,
			failed: 0,
			cancelled: false,
		})
		expect(fetchStats.calls.sort()).toEqual([alphaOne.fileName, alphaTwo.fileName].sort())
		expect(await getOfflineTrack(alphaOne.uuid)).toBeDefined()
		expect(await getOfflineTrack(alphaTwo.uuid)).toBeDefined()
		expect(await getOfflineTrack(betaOne.uuid)).toBeUndefined()
		expect(await getOfflineTrack(betaTwo.uuid)).toBeUndefined()
	})

	it('mixed состояния: current/new/stale/local/failed считаются независимо', async () => {
		await dbAddAlbum(1, 'Mixed Album')
		const currentTrack = await dbAddTrack(
			makeTrack({ albumName: 'Mixed Album', serverContent: 'already-here' }),
		)
		const newTrack = await dbAddTrack(
			makeTrack({ albumName: 'Mixed Album', serverContent: 'brand-new!!!' }),
		)
		const staleTrack = await dbAddTrack(
			makeTrack({
				albumName: 'Mixed Album',
				serverContent: 'fresh-bytes',
				lastModified: 2000,
			}),
		)
		await dbAddTrack(makeTrack({ albumName: 'Mixed Album', serverContent: null }))
		const failingTrack = makeTrack({ albumName: 'Mixed Album', serverContent: 'will-404!!!' })
		serverFiles.delete(failingTrack.fileName)
		await dbAddTrack(failingTrack)

		// current: копия совпадает с серверным файлом.
		await saveOfflineTrack(currentTrack, new NodeBlob(['already-here']) as unknown as Blob)
		// stale: копия есть, но серверный файл изменился (другой lastModified);
		// размер blob совпадает с size записи — иначе сработает truncation-guard.
		await saveOfflineTrack(
			{ ...staleTrack, file: { ...staleTrack.file, lastModified: 1 } } as Track,
			new NodeBlob(['stale-bytes']) as unknown as Blob,
		)
		fetchStats.calls = []

		const result = await downloadAlbum(1)

		expect(result).toEqual({
			total: 5,
			downloaded: 2,
			current: 1,
			skippedLocal: 1,
			failed: 1,
			cancelled: false,
		})
		// current не запрашивался заново; качались new, stale и упавший.
		expect(fetchStats.calls.sort()).toEqual(
			[newTrack.fileName, staleTrack.fileName, failingTrack.fileName].sort(),
		)
		// stale перезаписан свежими байтами.
		const staleRecord = await getOfflineTrack(staleTrack.uuid)
		expectToBeDefined(staleRecord)
		expect(staleRecord.lastModified).toBe(2000)
		expect(await staleRecord.blob.text()).toBe('fresh-bytes')
		// failed не оставляет записи.
		expect(await getOfflineTrack(failingTrack.uuid)).toBeUndefined()
	})

	it('повторный вызов для уже скачанного альбома: все current, 0 сетевых запросов', async () => {
		await dbAddAlbum(1, 'Repeat Album')
		const first = await dbAddTrack(
			makeTrack({ albumName: 'Repeat Album', serverContent: 'repeat-1!!!' }),
		)
		const second = await dbAddTrack(
			makeTrack({ albumName: 'Repeat Album', serverContent: 'repeat-2!!!' }),
		)

		await downloadAlbum(1)
		fetchStats.calls = []

		const result = await downloadAlbum(1)

		expect(result).toEqual({
			total: 2,
			downloaded: 0,
			current: 2,
			skippedLocal: 0,
			failed: 0,
			cancelled: false,
		})
		expect(fetchStats.calls).toHaveLength(0)
		expect(await getOfflineTrack(first.uuid)).toBeDefined()
		expect(await getOfflineTrack(second.uuid)).toBeDefined()
	})

	it('скачивает не более двух треков одновременно (concurrency 2)', async () => {
		await dbAddAlbum(1, 'Concurrent Album')
		for (let index = 0; index < 4; index += 1) {
			await dbAddTrack(
				makeTrack({ albumName: 'Concurrent Album', serverContent: 'x'.repeat(10) }),
			)
		}

		const result = await downloadAlbum(1)

		expect(result.downloaded).toBe(4)
		expect(fetchStats.maxActive).toBe(2)
	})

	it('cancel: batch прерывается без partial-записей, cancelled=true', async () => {
		await dbAddAlbum(1, 'Cancel Album')
		const tracks: Track[] = []
		for (let index = 0; index < 3; index += 1) {
			tracks.push(
				await dbAddTrack(
					makeTrack({ albumName: 'Cancel Album', serverContent: 'x'.repeat(10) }),
				),
			)
		}

		gateReleases = []
		const batchPromise = downloadAlbum(1)

		await vi.waitFor(() => {
			expect(fetchStats.active).toBe(2)
		})
		cancelDownloads()
		releaseFetchGate()

		const result = await batchPromise

		expect(result.cancelled).toBe(true)
		expect(result.downloaded).toBe(0)
		for (const track of tracks) {
			expect(await getOfflineTrack(track.uuid)).toBeUndefined()
		}
	})

	it('single-run: повторный вызов во время batch возвращает тот же promise', async () => {
		await dbAddAlbum(1, 'Single Album')
		await dbAddAlbum(2, 'Other Album')
		await dbAddTrack(makeTrack({ albumName: 'Single Album', serverContent: 'single-1!!!' }))
		await dbAddTrack(makeTrack({ albumName: 'Other Album', serverContent: 'other-1!!!!' }))

		const first = downloadAlbum(1)
		const second = downloadAlbum(2)

		expect(second).toBe(first)
		const result = await first
		// Скачан только альбом первого вызова.
		expect(result).toMatchObject({ total: 1, downloaded: 1 })
		expect(fetchStats.calls).toEqual(['music/album-track-1.mp3'])
	})

	it('single-run между playlist и album: общий batch, без параллельных дубликатов', async () => {
		await dbAddAlbum(1, 'Shared Album')
		const track = await dbAddTrack(
			makeTrack({ albumName: 'Shared Album', serverContent: 'shared-1!!' }),
		)
		await dbAddPlaylist(1, [track.id])

		const playlistBatch = downloadPlaylist(1)
		const albumBatch = downloadAlbum(1)

		expect(albumBatch).toBe(playlistBatch)
		const result = await playlistBatch
		expect(result.downloaded).toBe(1)
		expect(fetchStats.calls).toHaveLength(1)
	})

	it('пустой альбом (нет треков): total 0, без сетевых запросов и ошибки', async () => {
		await dbAddAlbum(1, 'Empty Album')

		const result = await downloadAlbum(1)

		expect(result).toEqual({
			total: 0,
			downloaded: 0,
			current: 0,
			skippedLocal: 0,
			failed: 0,
			cancelled: false,
		})
		expect(fetchStats.calls).toHaveLength(0)
	})

	it('ActiveBatchInfo album batch: albumId/label/currentTrackName и живой done/total', async () => {
		await dbAddAlbum(7, 'Progress Album')
		const trackNames: string[] = []
		for (let index = 0; index < 3; index += 1) {
			const track = await dbAddTrack(
				makeTrack({ albumName: 'Progress Album', serverContent: 'p'.repeat(10) }),
			)
			trackNames.push(track.name)
		}

		const snapshots: ActiveBatchInfo[] = []
		const unsubscribe = subscribeDownloads(() => {
			const info = getActiveBatch()
			if (info !== null) {
				snapshots.push({ ...info })
			}
		})

		try {
			const result = await downloadAlbum(7)
			expect(result.downloaded).toBe(3)
		} finally {
			unsubscribe()
		}

		expect(snapshots.length).toBeGreaterThan(0)

		const first = snapshots[0]
		expectToBeDefined(first)
		expect(first.albumId).toBe(7)
		expect(first.label).toBe('Progress Album')
		expect(first.total).toBe(3)
		// playlistId не выставлен у album batch.
		expect(first.playlistId).toBeUndefined()

		// done растёт монотонно и доходит до total.
		const doneValues = snapshots.map((snapshot) => snapshot.done)
		const monotonic = doneValues.every(
			(value, index) => index === 0 || value >= (doneValues[index - 1] ?? 0),
		)
		expect(monotonic).toBe(true)
		expect(Math.max(...doneValues)).toBe(3)

		// currentTrackName, когда выставлен, — имя трека именно этого альбома.
		const currentNames = snapshots
			.map((snapshot) => snapshot.currentTrackName)
			.filter((name): name is string => name !== undefined)
		expect(currentNames.length).toBeGreaterThan(0)
		for (const name of currentNames) {
			expect(trackNames).toContain(name)
		}

		// После завершения активного batch нет.
		expect(getActiveBatch()).toBeNull()
	})

	it('ActiveBatchInfo playlist batch: label = имя плейлиста, playlistId сохранён', async () => {
		const track = await dbAddTrack(
			makeTrack({ albumName: 'Any Album', serverContent: 'playlist-1' }),
		)
		await dbAddPlaylist(5, [track.id])

		const snapshots: ActiveBatchInfo[] = []
		const unsubscribe = subscribeDownloads(() => {
			const info = getActiveBatch()
			if (info !== null) {
				snapshots.push({ ...info })
			}
		})

		try {
			await downloadPlaylist(5)
		} finally {
			unsubscribe()
		}

		expect(snapshots.length).toBeGreaterThan(0)
		const first = snapshots[0]
		expectToBeDefined(first)
		expect(first.playlistId).toBe(5)
		expect(first.label).toBe('Playlist 5')
		expect(first.albumId).toBeUndefined()
		expect(first.total).toBe(1)
	})
})
