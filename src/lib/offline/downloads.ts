/**
 * Downloading server library tracks into the offline store (CONTRACTS.md §12).
 *
 * This is the app's internal offline storage: nothing here produces ZIPs or
 * touches the system Downloads folder. Bytes always come from the existing
 * authenticated server file endpoint; persistence goes through
 * `./store.ts` (`offlineTracks` IndexedDB store), which also dispatches the
 * `offlineTracks` database change events the UI reacts to.
 */

import { getDatabase } from '#lib/db/database.ts'
import { isServerFileEntity } from '#lib/helpers/file-system.ts'
import type { Track } from '#lib/library/types.ts'
import { getServerLibraryFileUrl } from '#lib/server-library/api.ts'
import { getOfflineTrack, isOfflineTrackCurrent, saveOfflineTrack } from './store.ts'

/** Outcome of a playlist batch, see {@link downloadPlaylist}. */
export interface PlaylistDownloadResult {
	/** Unique tracks of the playlist at batch start. */
	total: number
	/** Tracks downloaded during this batch. */
	downloaded: number
	/** Server tracks whose offline copy was already current (no re-download). */
	current: number
	/** Local File/FileSystem tracks: already on the device, never downloaded. */
	skippedLocal: number
	/** Tracks that failed to download; a failure never stops the rest. */
	failed: number
	/** Whether {@link cancelDownloads} aborted the batch early. */
	cancelled: boolean
}

/** Snapshot of the currently running playlist batch, for progress UI. */
export interface ActiveBatchInfo {
	playlistId: number
	done: number
	total: number
}

/**
 * Thrown before a batch starts when `navigator.storage.estimate()` shows
 * there is clearly not enough room for the files still to download.
 */
export class OfflineStorageQuotaError extends Error {
	readonly neededBytes: number
	readonly availableBytes: number

	constructor(neededBytes: number, availableBytes: number) {
		super(
			`Not enough storage for offline downloads: need ${neededBytes} bytes, ${availableBytes} available`,
		)
		this.name = 'OfflineStorageQuotaError'
		this.neededBytes = neededBytes
		this.availableBytes = availableBytes
	}
}

/** Thrown when the server file endpoint answers with a non-OK status. */
class ServerFileDownloadError extends Error {
	readonly httpStatus: number

	constructor(httpStatus: number, path: string) {
		super(`Failed to download "${path}": HTTP ${httpStatus}`)
		this.name = 'ServerFileDownloadError'
		this.httpStatus = httpStatus
	}
}

export const isAbortError = (error: unknown): boolean =>
	error instanceof Error && error.name === 'AbortError'

const BATCH_CONCURRENCY = 2

// ---------------------------------------------------------------------------
// In-flight bookkeeping. Plain module state + listeners; the reactive mirror
// for Svelte lives in `download-status.svelte.ts`.
// ---------------------------------------------------------------------------

const activeTrackDownloads = new Map<string, Promise<'downloaded' | 'current'>>()
const lastTrackErrors = new Map<string, unknown>()

interface ActiveBatch extends ActiveBatchInfo {
	controller: AbortController
	promise: Promise<PlaylistDownloadResult>
}

let activeBatch: ActiveBatch | null = null

// Downloads started outside a batch (the track menu) share one controller so
// `cancelDownloads` can abort them too. Replaced after every cancel.
let manualController = new AbortController()

const listeners = new Set<() => void>()

/** Notifies on every download lifecycle change: start, progress, finish, error. */
export const subscribeDownloads = (listener: () => void): (() => void) => {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

const notifyListeners = () => {
	for (const listener of listeners) {
		listener()
	}
}

/** Whether this track is being downloaded right now. */
export const isTrackDownloadActive = (trackUuid: string): boolean =>
	activeTrackDownloads.has(trackUuid)

/** The error of the track's last failed download, until a retry starts. */
export const getTrackDownloadError = (trackUuid: string): unknown => lastTrackErrors.get(trackUuid)

/** The running playlist batch, if any. */
export const getActiveBatch = (): ActiveBatchInfo | null =>
	activeBatch && {
		playlistId: activeBatch.playlistId,
		done: activeBatch.done,
		total: activeBatch.total,
	}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const fetchServerFileBlob = async (path: string, signal?: AbortSignal): Promise<Blob> => {
	const response = await fetch(getServerLibraryFileUrl(path), { signal })

	if (!response.ok) {
		throw new ServerFileDownloadError(response.status, path)
	}

	return await response.blob()
}

/**
 * Downloads the full blob first and only then persists it, so a cancelled or
 * truncated download never leaves a partial record behind (`saveOfflineTrack`
 * additionally rejects size mismatches).
 */
const performTrackDownload = async (
	track: Track,
	signal: AbortSignal | undefined,
): Promise<'downloaded' | 'current'> => {
	const existing = await getOfflineTrack(track.uuid)
	if (existing && isOfflineTrackCurrent(existing, track)) {
		return 'current'
	}

	const file = track.file
	if (!isServerFileEntity(file)) {
		// Unreachable through the public API; guards the batch path too.
		throw new Error('Only server library tracks can be downloaded for offline')
	}

	const blob = await fetchServerFileBlob(file.path, signal)
	await saveOfflineTrack(track, blob)

	return 'downloaded'
}

/**
 * Starts (or joins) the download of one server track. Concurrent requests for
 * the same track share a single fetch.
 */
const startTrackDownload = (
	track: Track,
	signal: AbortSignal | undefined,
): Promise<'downloaded' | 'current'> => {
	const inFlight = activeTrackDownloads.get(track.uuid)
	if (inFlight) {
		return inFlight
	}

	lastTrackErrors.delete(track.uuid)
	notifyListeners()

	const promise = performTrackDownload(track, signal)
		.catch((error: unknown) => {
			if (!isAbortError(error)) {
				lastTrackErrors.set(track.uuid, error)
				notifyListeners()
			}

			throw error
		})
		.finally(() => {
			activeTrackDownloads.delete(track.uuid)
			notifyListeners()
		})

	activeTrackDownloads.set(track.uuid, promise)

	return promise
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Downloads a single server library track for offline playback.
 *
 * Resolves `'current'` without a network request when a matching offline copy
 * already exists. Local File/FileSystem tracks are already offline and are
 * rejected. Failures (network, HTTP, quota, truncation guard) reject; a
 * partial blob is never persisted.
 */
export const downloadTrack = (track: Track): Promise<'downloaded' | 'current'> => {
	if (!isServerFileEntity(track.file)) {
		return Promise.reject(new Error('Only server library tracks can be downloaded for offline'))
	}

	return startTrackDownload(track, manualController.signal)
}

const ensureStorageAvailable = async (neededBytes: number): Promise<void> => {
	const storage = globalThis.navigator?.storage
	if (!storage) {
		return
	}

	// Best-effort persistent storage: a refusal must not block downloading.
	try {
		await storage.persist?.()
	} catch {
		// Ignored: persistence is a hint, not a requirement.
	}

	if (neededBytes <= 0 || !storage.estimate) {
		return
	}

	let estimate: StorageEstimate
	try {
		estimate = await storage.estimate()
	} catch {
		// Best-effort: without an estimate we simply try the downloads.
		return
	}

	const { quota, usage } = estimate
	if (quota === undefined || usage === undefined) {
		return
	}

	const availableBytes = quota - usage
	if (availableBytes < neededBytes) {
		throw new OfflineStorageQuotaError(neededBytes, availableBytes)
	}
}

/**
 * Bytes still missing offline for the given server tracks. Current copies
 * cost nothing; stale ones are re-downloaded in full.
 */
const estimateMissingBytes = async (tracks: readonly Track[]): Promise<number> => {
	let neededBytes = 0

	for (const track of tracks) {
		if (!isServerFileEntity(track.file)) {
			continue
		}

		const record = await getOfflineTrack(track.uuid)
		if (!(record && isOfflineTrackCurrent(record, track))) {
			neededBytes += track.file.size
		}
	}

	return neededBytes
}

/**
 * Downloads every track of the playlist as it is right now (its current
 * `playlistEntries`, favorites pseudo-playlist included). Duplicate entries
 * of one track are downloaded once.
 *
 * Two tracks download concurrently; one shared AbortController backs the
 * whole batch. A failing track increments `failed` and never stops the rest;
 * `cancelDownloads()` aborts the batch without persisting partial files.
 * While a batch runs, further calls return the same promise — no parallel
 * duplicate batches.
 */
export const downloadPlaylist = (playlistId: number): Promise<PlaylistDownloadResult> => {
	if (activeBatch) {
		return activeBatch.promise
	}

	const controller = new AbortController()
	const batch: ActiveBatch = {
		playlistId,
		controller,
		done: 0,
		total: 0,
		promise: undefined as unknown as Promise<PlaylistDownloadResult>,
	}

	const run = async (): Promise<PlaylistDownloadResult> => {
		const db = await getDatabase()
		const entries = await db.getAllFromIndex('playlistEntries', 'playlistId', playlistId)

		// The batch is exactly this playlist's current entries; duplicate
		// entries of one track download (and count) once.
		const trackIds = [...new Set(entries.map((entry) => entry.trackId))]
		const foundTracks = await Promise.all(trackIds.map((id) => db.get('tracks', id)))
		const tracks = foundTracks.filter((track) => track !== undefined)

		batch.total = tracks.length
		notifyListeners()

		const result: PlaylistDownloadResult = {
			total: tracks.length,
			downloaded: 0,
			current: 0,
			skippedLocal: 0,
			failed: 0,
			cancelled: false,
		}

		if (tracks.length === 0) {
			return result
		}

		await ensureStorageAvailable(await estimateMissingBytes(tracks))

		const queue = [...tracks]
		const worker = async (): Promise<void> => {
			while (!controller.signal.aborted) {
				const track = queue.shift()
				if (!track) {
					return
				}

				try {
					if (isServerFileEntity(track.file)) {
						const outcome = await startTrackDownload(track, controller.signal)
						if (outcome === 'current') {
							result.current += 1
						} else {
							result.downloaded += 1
						}
					} else {
						result.skippedLocal += 1
					}
				} catch (error) {
					if (isAbortError(error)) {
						return
					}

					result.failed += 1
				} finally {
					batch.done += 1
					notifyListeners()
				}
			}
		}

		await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, () => worker()))

		if (controller.signal.aborted) {
			result.cancelled = true
		}

		return result
	}

	batch.promise = run().finally(() => {
		activeBatch = null
		notifyListeners()
	})

	activeBatch = batch
	notifyListeners()

	return batch.promise
}

/**
 * Aborts the running playlist batch and any in-flight single-track downloads.
 * Partially downloaded files are never persisted: the blob is written to the
 * offline store only after it has been fetched in full.
 */
export const cancelDownloads = (): void => {
	activeBatch?.controller.abort()

	manualController.abort()
	manualController = new AbortController()
}
