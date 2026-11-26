import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '#lib/db/database.ts'
import { clearDatabaseStores, expectToBeDefined } from '#lib/helpers/test-helpers.ts'
import { FAVORITE_PLAYLIST_ID, SERVER_DIRECTORY_ID, type Track } from '#lib/library/types.ts'
import {
	cancelDownloads,
	downloadPlaylist,
	downloadTrack,
	OfflineStorageQuotaError,
} from '../downloads.ts'
import { getOfflineTrack, saveOfflineTrack } from '../store.ts'

// ---------------------------------------------------------------------------
// In-memory "server": path -> file body (ASCII content, so byte size equals
// the string length). The fetch mock serves exactly these bodies from the
// real file endpoint URL shape.
// ---------------------------------------------------------------------------

const serverFiles = new Map<string, string>()

interface FetchStats {
	calls: string[]
	active: number
	maxActive: number
}

let fetchStats: FetchStats

/** When non-null, blob responses wait for an explicit release (for cancel tests). */
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
					// Yield a macrotask so concurrent downloads actually overlap.
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
					// A happy-dom Blob does not survive the structuredClone inside
					// fake-indexeddb; the node:buffer one round-trips intact.
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
// Track/playlist fixtures
// ---------------------------------------------------------------------------

let trackCounter = 0

interface TestTrackOptions {
	/** Serves the track from the in-memory server unless null (local track). */
	serverContent: string | null
	size?: number
	lastModified?: number
}

const makeTrack = (options: TestTrackOptions): Track => {
	trackCounter += 1
	const id = trackCounter
	const fileName = `music/track-${id}.mp3`
	const content = options.serverContent

	if (content !== null) {
		serverFiles.set(fileName, content)
	}

	const size = options.size ?? (content === null ? 4 : content.length)

	const file: Track['file'] =
		content === null
			? new File(['local'], `track-${id}.mp3`, { type: 'audio/mpeg' })
			: {
					kind: 'server',
					path: fileName,
					name: `track-${id}.mp3`,
					size,
					lastModified: options.lastModified ?? 1000,
				}

	return {
		id,
		uuid: `server:test-track-${id}`,
		name: `Track ${id}`,
		album: 'Album',
		artists: ['Artist'],
		year: '2024',
		duration: 180,
		genre: [],
		trackNo: 1,
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

const addFavoriteEntry = async (trackId: number): Promise<void> => {
	const db = await getDatabase()
	await db.add('playlistEntries', {
		playlistId: FAVORITE_PLAYLIST_ID,
		trackId,
		addedAt: 1000,
	} as never)
}

const SERVER_ONLY_ERROR_RE = /server library tracks/i

describe('offline downloads', () => {
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

	describe('downloadTrack', () => {
		it('downloads a server track into the offline store', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: 'abcdefghij' }))

			const outcome = await downloadTrack(track)

			expect(outcome).toBe('downloaded')
			expect(fetchStats.calls).toEqual(['music/track-1.mp3'])

			const record = await getOfflineTrack(track.uuid)
			expectToBeDefined(record)
			expect(record.size).toBe(10)
			expect(record.fileName).toBe('track-1.mp3')
			expect(record.blob.size).toBe(10)
			expect(record.blob.type).toBe('audio/mpeg')
			expect(await record.blob.text()).toBe('abcdefghij')
		})

		it('returns current without a new request when the copy matches', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: 'abcdefghij' }))

			await downloadTrack(track)
			const outcome = await downloadTrack(track)

			expect(outcome).toBe('current')
			expect(fetchStats.calls).toHaveLength(1)
		})

		it('re-downloads a stale copy after the server file changed', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: 'abcdefghij' }))
			await saveOfflineTrack(
				{ ...track, file: { ...track.file, lastModified: 1 } } as Track,
				new NodeBlob(['abcdefghij']) as unknown as Blob,
			)

			const outcome = await downloadTrack(track)

			expect(outcome).toBe('downloaded')
			expect(fetchStats.calls).toHaveLength(1)

			const record = await getOfflineTrack(track.uuid)
			expectToBeDefined(record)
			expect(record.lastModified).toBe(1000)
		})

		it('rejects on a server error and persists nothing', async () => {
			const track = makeTrack({ serverContent: 'abcdefghij' })
			serverFiles.delete(track.fileName)
			await dbAddTrack(track)

			await expect(downloadTrack(track)).rejects.toThrow()
			expect(await getOfflineTrack(track.uuid)).toBeUndefined()
		})

		it('rejects local tracks without touching the network', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: null }))

			await expect(downloadTrack(track)).rejects.toThrow(SERVER_ONLY_ERROR_RE)
			expect(fetchStats.calls).toHaveLength(0)
		})

		it('shares one request between concurrent downloads of the same track', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: 'abcdefghij' }))

			const [first, second] = await Promise.all([downloadTrack(track), downloadTrack(track)])

			expect(first).toBe('downloaded')
			expect(second).toBe('downloaded')
			expect(fetchStats.calls).toHaveLength(1)
		})
	})

	describe('downloadPlaylist', () => {
		it('processes current, new, local and failing tracks independently', async () => {
			const currentTrack = await dbAddTrack(makeTrack({ serverContent: 'aaaaaaaaaa' }))
			const newTrack = await dbAddTrack(makeTrack({ serverContent: 'bbbbbbbbbbbb' }))
			const localTrack = await dbAddTrack(makeTrack({ serverContent: null }))
			const failingTrack = makeTrack({ serverContent: 'cccccccccc' })
			serverFiles.delete(failingTrack.fileName)
			await dbAddTrack(failingTrack)

			await downloadTrack(currentTrack)
			fetchStats.calls = []

			await dbAddPlaylist(1, [currentTrack.id, newTrack.id, localTrack.id, failingTrack.id])

			const result = await downloadPlaylist(1)

			expect(result).toEqual({
				total: 4,
				downloaded: 1,
				current: 1,
				skippedLocal: 1,
				failed: 1,
				cancelled: false,
			})
			// The current track was not requested again.
			expect(fetchStats.calls.sort()).toEqual(['music/track-2.mp3', 'music/track-4.mp3'])
			expect(await getOfflineTrack(newTrack.uuid)).toBeDefined()
			expect(await getOfflineTrack(failingTrack.uuid)).toBeUndefined()
		})

		it('downloads the current entries of the favorites pseudo-playlist', async () => {
			const favoriteTrack = await dbAddTrack(makeTrack({ serverContent: 'aaaaaaaaaa' }))
			const otherTrack = await dbAddTrack(makeTrack({ serverContent: 'bbbbbbbbbb' }))
			await addFavoriteEntry(favoriteTrack.id)

			const result = await downloadPlaylist(FAVORITE_PLAYLIST_ID)

			expect(result).toEqual({
				total: 1,
				downloaded: 1,
				current: 0,
				skippedLocal: 0,
				failed: 0,
				cancelled: false,
			})
			expect(await getOfflineTrack(favoriteTrack.uuid)).toBeDefined()
			expect(await getOfflineTrack(otherTrack.uuid)).toBeUndefined()
		})

		it('runs at most two downloads concurrently', async () => {
			const trackIds: number[] = []
			for (let index = 0; index < 4; index += 1) {
				const track = await dbAddTrack(makeTrack({ serverContent: 'x'.repeat(10) }))
				trackIds.push(track.id)
			}
			await dbAddPlaylist(1, trackIds)

			const result = await downloadPlaylist(1)

			expect(result.downloaded).toBe(4)
			expect(fetchStats.maxActive).toBe(2)
		})

		it('returns the running batch promise instead of starting a duplicate', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: 'abcdefghij' }))
			await dbAddPlaylist(1, [track.id])

			const first = downloadPlaylist(1)
			const second = downloadPlaylist(1)

			expect(second).toBe(first)
			await first
			expect(fetchStats.calls).toHaveLength(1)
		})

		it('cancels the batch without persisting partial downloads', async () => {
			const trackIds: number[] = []
			const tracks: Track[] = []
			for (let index = 0; index < 3; index += 1) {
				const track = await dbAddTrack(makeTrack({ serverContent: 'x'.repeat(10) }))
				tracks.push(track)
				trackIds.push(track.id)
			}
			await dbAddPlaylist(1, trackIds)

			gateReleases = []
			const batchPromise = downloadPlaylist(1)

			// Let both workers reach their fetches, then cancel.
			await vi.waitFor(() => {
				expect(fetchStats.active).toBe(2)
			})
			cancelDownloads()

			// The in-flight fetches resolve after the abort signal fired.
			releaseFetchGate()

			const result = await batchPromise

			expect(result.cancelled).toBe(true)
			expect(result.downloaded).toBe(0)
			// Nothing partially downloaded was persisted.
			for (const track of tracks) {
				expect(await getOfflineTrack(track.uuid)).toBeUndefined()
			}
		})
	})

	describe('storage checks', () => {
		it('rejects with OfflineStorageQuotaError before downloading when space is short', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: 'x'.repeat(100) }))
			await dbAddPlaylist(1, [track.id])

			vi.stubGlobal('navigator', {
				storage: {
					estimate: async () => ({ quota: 50, usage: 40 }),
					persist: async () => false,
				},
			})

			await expect(downloadPlaylist(1)).rejects.toBeInstanceOf(OfflineStorageQuotaError)
			expect(fetchStats.calls).toHaveLength(0)
		})

		it('downloads despite persist() refusal when there is enough space', async () => {
			const track = await dbAddTrack(makeTrack({ serverContent: 'abcdefghij' }))
			await dbAddPlaylist(1, [track.id])

			vi.stubGlobal('navigator', {
				storage: {
					estimate: async () => ({ quota: 1000, usage: 10 }),
					persist: async () => false,
				},
			})

			const result = await downloadPlaylist(1)

			expect(result.downloaded).toBe(1)
			expect(await getOfflineTrack(track.uuid)).toBeDefined()
		})
	})
})
