import { getDatabase } from '#lib/db/database.ts'
import {
	type FileEntity,
	getFileHandlesRecursively,
	isServerFileEntity,
	type LocalFileEntity,
} from '#lib/helpers/file-system.ts'
import { sha256Hex } from '#lib/helpers/hash.ts'
import { SerialQueue } from '#lib/helpers/serial-queue.ts'
import { dbRemoveTracks } from '#lib/library/remove.ts'
import {
	CURRENT_METADATA_VERSION,
	type ImageRecord,
	LEGACY_NO_NATIVE_DIRECTORY,
	type ServerFileEntity,
	type Track,
} from '#lib/library/types.ts'
import type { ServerFileDescriptor } from '#lib/server-library/api.ts'
import {
	fetchServerLibraryArtwork,
	fetchServerLibraryCatalog,
	requestServerLibraryRescan,
	type ServerCatalogTrack,
	type ServerLibraryCatalogResponse,
	ServerLibraryRequestError,
	type ServerLibraryScanStatus,
	waitForServerLibraryScan,
} from '#lib/server-library/client.ts'
import { createImageRecord } from './steps/create-image-record.ts'
import { dbImportTrack } from './steps/import-track.ts'
import { parseTrackMetadata } from './steps/parse-track-metadata.ts'
import type { TracksScanMessage, TracksScanOptions } from './types.ts'

declare const self: DedicatedWorkerGlobalScope

interface TrackEnqueueOptions {
	scannedAt: number
	unwrappedFile: File
	file: FileEntity
	directoryId: number
	/** Overrides the stored `fileName`; server tracks keep their full relative path there */
	fileName?: string
	/** In cases when track already was imported */
	trackId?: number
	uuid?: string
}

interface ArtworkEntry {
	imageHash: string
	primaryColor: number | undefined
	/** The full record, retained so imports can put-if-absent without re-decoding. */
	record: ImageRecord
}

const MAX_CACHED_ARTWORKS = 64

/**
 * A three-stage pipeline for track ingestion:
 * 1. [PARSING]  - Blocks the caller; processes one file at a time.
 * 2. [ARTWORK]  - Background serial queue for I/O-heavy image processing.
 * 3. [IMPORT]   - Background serial queue for final database writes.
 * - This "conveyor belt" allows the caller to parse the next track while
 * previous tracks progress through artwork and import stages concurrently.
 */
class TrackProcessor {
	#artworkQueue = new SerialQueue()
	#importQueue = new SerialQueue()

	#imageCache = new Map<string, ArtworkEntry>()

	#tracker: StatusTracker
	#onImportSuccess?: (trackId: number) => void

	constructor(tracker: StatusTracker, onImportSuccess?: (trackId: number) => void) {
		this.#tracker = tracker
		this.#onImportSuccess = onImportSuccess
	}

	async #resolveArtwork(imageBlob: Blob): Promise<ArtworkEntry> {
		const hash = await sha256Hex(imageBlob)

		const cached = this.#imageCache.get(hash)
		if (cached) {
			return cached
		}

		// Cross-scan hit: the record already exists from a previous scan, so we can
		// skip decode/resize/color-extraction entirely.
		const db = await getDatabase()
		const existing = await db.get('images', hash)
		const record = existing ?? (await createImageRecord(imageBlob, hash))

		const entry: ArtworkEntry = {
			imageHash: hash,
			primaryColor: record.primaryColor,
			record,
		}
		this.#imageCache.set(hash, entry)

		if (this.#imageCache.size > MAX_CACHED_ARTWORKS) {
			const oldest = this.#imageCache.keys().next().value
			if (oldest !== undefined) {
				this.#imageCache.delete(oldest)
			}
		}

		return entry
	}

	async parseAndEnqueue(options: TrackEnqueueOptions) {
		const parsed = await parseTrackMetadata(options.unwrappedFile)
		if (!parsed) {
			return
		}

		void this.#artworkQueue
			.enqueue(async () => {
				const imageBlob = parsed.imageBlob
				const artwork = imageBlob ? await this.#resolveArtwork(imageBlob) : undefined

				void this.#importQueue.enqueue(async () => {
					try {
						const trackId = await dbImportTrack(
							{
								...parsed.data,
								imageHash: artwork?.imageHash,
								primaryColor: artwork?.primaryColor,
								file: options.file,
								directory: options.directoryId,
								fileName: options.fileName ?? options.file.name,
								scannedAt: options.scannedAt,
								uuid: options.uuid ?? crypto.randomUUID(),
							},
							options.trackId,
							artwork?.record,
						)

						this.#onImportSuccess?.(trackId)
						this.#tracker.newlyImported += 1
					} catch (err) {
						console.error(err)
					} finally {
						this.#tracker.sendMsg(false)
					}
				})
			})
			.catch((err: unknown) => console.error(err))
	}

	async drain(): Promise<void> {
		await this.#artworkQueue.drain()
		await this.#importQueue.drain()
	}
}

class StatusTracker {
	newlyImported = 0

	current = 0

	total = 0

	#pendingTimeout: number | null = null
	#hasPendingMessage = false

	#timeId: string

	constructor(total: number, timeId: string) {
		this.total = total
		this.#timeId = timeId

		console.time(this.#timeId)
	}

	sendMsg = (finished: boolean) => {
		if (finished) {
			console.timeEnd(this.#timeId)
			if (this.#pendingTimeout) {
				self.clearTimeout(this.#pendingTimeout)
			}
		} else {
			if (this.#pendingTimeout) {
				this.#hasPendingMessage = true
				return
			}

			this.#pendingTimeout = self.setTimeout(() => {
				this.#pendingTimeout = null
				if (this.#hasPendingMessage) {
					this.#hasPendingMessage = false
					this.#postMessage(false)
				}
			}, 200)
		}

		this.#postMessage(finished)
	}

	#postMessage = (finished: boolean): void => {
		const message: TracksScanMessage = {
			finished,
			count: {
				newlyImported: this.newlyImported,
				current: this.current,
				total: this.total,
			},
		}

		self.postMessage(message)
	}
}

const findTrackByFileHandle = async (handle: FileSystemFileHandle, tracks: Track[]) => {
	for (const track of tracks) {
		const isSame = await handle.isSameEntry(track.file as FileSystemFileHandle)
		if (isSame) {
			return track
		}
	}

	return null
}

const findTrackByMixedFileEntity = async (handle: LocalFileEntity, tracks: Track[]) => {
	for (const track of tracks) {
		const existingFile = track.file
		// If file name is changed we can be sure it's not the same file anymore
		if (existingFile.name !== handle.name) {
			continue
		}

		if (
			existingFile instanceof FileSystemFileHandle &&
			handle instanceof FileSystemFileHandle
		) {
			const isSame = await handle.isSameEntry(existingFile)
			if (isSame) {
				return track
			}
		}

		// No reliable way to compare two Files,
		// so we compare their names and size
		if (
			existingFile instanceof File &&
			handle instanceof File &&
			existingFile.size === handle.size
		) {
			return track
		}
	}

	return null
}

const scanExistingDirectory = async (handles: LocalFileEntity[], directoryId: number) => {
	const db = await getDatabase()

	const tracker = new StatusTracker(handles.length, 'SCAN_EXISTING_DIR')
	const scannedTracksIds = new Set<number>()
	const processor = new TrackProcessor(tracker, (trackId) => {
		scannedTracksIds.add(trackId)
	})

	const scannedAt = Date.now()

	const findTrackFn =
		directoryId === LEGACY_NO_NATIVE_DIRECTORY
			? findTrackByMixedFileEntity
			: findTrackByFileHandle

	for (const handle of handles) {
		tracker.current += 1

		try {
			// Real FS might have multiple files with the same name
			// but in the database we keep flat structure
			const possibleExistingTracks = await db.getAllFromIndex('tracks', 'path', [
				directoryId,
				handle.name,
			])
			const existingTrack = await findTrackFn(
				// If `LEGACY_NO_NATIVE_DIRECTORY` is used this will be a `File` or `FileSystemFileHandle`
				// in all other cases it will be a `FileSystemFileHandle`
				handle as FileSystemFileHandle,
				possibleExistingTracks,
			)

			const unwrappedFile = handle instanceof File ? handle : await handle.getFile()

			// File was not modified since last scan
			if (
				existingTrack &&
				unwrappedFile.lastModified <= existingTrack.scannedAt &&
				existingTrack.metadataVersion === CURRENT_METADATA_VERSION
			) {
				scannedTracksIds.add(existingTrack.id)
				tracker.sendMsg(false)

				continue
			}

			await processor.parseAndEnqueue({
				unwrappedFile,
				file: handle,
				directoryId,
				trackId: existingTrack?.id,
				uuid: existingTrack?.uuid,
				scannedAt,
			})
		} catch {
			// we ignore errors and just move on to the next track.
		}
	}

	await processor.drain()

	if (directoryId === LEGACY_NO_NATIVE_DIRECTORY) {
		tracker.sendMsg(true)

		return
	}

	// After importing is done, we remove tracks that were not scanned
	// meaning they do not exist in the actual FS anymore
	const tracksIdsInDirectory = await db.getAllKeysFromIndex('tracks', 'directory', directoryId)
	const tracksToRemove: number[] = []
	for (const trackId of tracksIdsInDirectory) {
		if (!scannedTracksIds.has(trackId)) {
			tracksToRemove.push(trackId)
		}
	}
	await dbRemoveTracks(tracksToRemove).catch(console.warn)

	tracker.sendMsg(true)
}

const scanNewDirectory = async (handles: LocalFileEntity[], directoryId: number) => {
	const tracker = new StatusTracker(handles.length, 'SCAN_NEW_DIR')
	const processor = new TrackProcessor(tracker)
	const scannedAt = Date.now()

	for (const handle of handles) {
		tracker.current += 1

		try {
			const unwrappedFile = handle instanceof File ? handle : await handle.getFile()

			await processor.parseAndEnqueue({
				unwrappedFile,
				file: handle,
				directoryId,
				scannedAt,
			})
		} catch {
			// we ignore errors and just move on to the next track
		}
	}

	await processor.drain()

	tracker.sendMsg(true)
}

const toServerFileEntity = (descriptor: ServerFileDescriptor): ServerFileEntity => ({
	kind: 'server',
	path: descriptor.path,
	name: descriptor.name,
	size: descriptor.size,
	lastModified: descriptor.lastModified,
})

/**
 * A stored server track is up to date only when the catalog entry describes
 * the same file contents and carries the same stable uuid. The uuid
 * comparison also migrates tracks imported by the legacy download-based
 * scan (random uuids) to their stable server identity in place.
 */
const isServerTrackUnchanged = (track: Track, entry: ServerCatalogTrack): boolean =>
	track.metadataVersion === CURRENT_METADATA_VERSION &&
	track.uuid === entry.uuid &&
	isServerFileEntity(track.file) &&
	track.file.size === entry.descriptor.size &&
	track.file.lastModified === entry.descriptor.lastModified

const SERVER_ARTWORK_CACHE_LIMIT = 64

/** Server-side scan progress is forwarded to the UI while the worker waits for the index. */
const postServerScanProgress = (status: ServerLibraryScanStatus): void => {
	const message: TracksScanMessage = {
		finished: false,
		count: {
			newlyImported: 0,
			current: status.current ?? 0,
			total: status.total ?? 0,
			phase: 'server-scan',
		},
	}

	self.postMessage(message)
}

/**
 * Resolves artwork by content hash without downloading it twice: an in-run
 * cache covers repeats within one import, IndexedDB covers rescans.
 * `dbImportTrack` keeps the content-addressed put-if-absent semantics.
 */
const resolveCatalogArtwork = async (
	cache: Map<string, ImageRecord>,
	hash: string,
): Promise<ImageRecord> => {
	const cached = cache.get(hash)
	if (cached) {
		return cached
	}

	const db = await getDatabase()
	const existing = await db.get('images', hash)
	const record =
		existing ?? (await createImageRecord(await fetchServerLibraryArtwork(hash), hash))

	cache.set(hash, record)
	if (cache.size > SERVER_ARTWORK_CACHE_LIMIT) {
		const oldest = cache.keys().next().value
		if (oldest !== undefined) {
			cache.delete(oldest)
		}
	}

	return record
}

/** Retries the catalog once the server scan that produced the first 409 has finished. */
const MAX_CATALOG_ATTEMPTS = 3

const fetchCatalogAfterScan = async (): Promise<ServerLibraryCatalogResponse> => {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await fetchServerLibraryCatalog()
		} catch (err) {
			const scanInProgress =
				err instanceof ServerLibraryRequestError && err.code === 'SCAN_IN_PROGRESS'
			if (!scanInProgress || attempt >= MAX_CATALOG_ATTEMPTS) {
				throw err
			}

			await waitForServerLibraryScan({ onProgress: postServerScanProgress })
		}
	}
}

/**
 * Imports a completed server catalog (CONTRACTS.md §10). No audio is
 * downloaded and no browser metadata parsing happens on this path: the
 * server-provided `data` goes straight into the existing import pipeline,
 * artwork is fetched by hash only when absent from IndexedDB.
 */
const scanServerCatalog = async (catalog: ServerLibraryCatalogResponse, directoryId: number) => {
	const db = await getDatabase()
	const existingTracks = await db.getAllFromIndex('tracks', 'directory', directoryId)
	const existingTracksByPath = new Map(existingTracks.map((track) => [track.fileName, track]))

	const tracker = new StatusTracker(catalog.tracks.length, 'SCAN_SERVER_CATALOG')
	const scannedTracksIds = new Set<number>()
	const artworkCache = new Map<string, ImageRecord>()

	const scannedAt = Date.now()

	for (const entry of catalog.tracks) {
		tracker.current += 1

		try {
			const existingTrack = existingTracksByPath.get(entry.descriptor.path)
			// The path is confirmed by the successful catalog, so the previous
			// record must survive a failed re-import; only paths missing from
			// the catalog are removed after the scan.
			if (existingTrack) {
				scannedTracksIds.add(existingTrack.id)
			}

			if (existingTrack && isServerTrackUnchanged(existingTrack, entry)) {
				tracker.sendMsg(false)

				continue
			}

			const imageRecord = entry.artwork
				? await resolveCatalogArtwork(artworkCache, entry.artwork.hash)
				: undefined

			const trackId = await dbImportTrack(
				{
					...entry.data,
					imageHash: entry.artwork?.hash,
					primaryColor: imageRecord?.primaryColor,
					metadataVersion: CURRENT_METADATA_VERSION,
					file: toServerFileEntity(entry.descriptor),
					directory: directoryId,
					fileName: entry.descriptor.path,
					scannedAt,
					uuid: entry.uuid,
				},
				existingTrack?.id,
				imageRecord,
			)

			scannedTracksIds.add(trackId)
			tracker.newlyImported += 1
			tracker.sendMsg(false)
		} catch (err) {
			// A single broken entry must not abort the scan; its previous record survives.
			console.error(err)
		}
	}

	// After importing is done, we remove tracks that were not scanned
	// meaning their files no longer exist on the server
	const tracksIdsInDirectory = await db.getAllKeysFromIndex('tracks', 'directory', directoryId)
	const tracksToRemove: number[] = []
	for (const trackId of tracksIdsInDirectory) {
		if (!scannedTracksIds.has(trackId)) {
			tracksToRemove.push(trackId)
		}
	}
	await dbRemoveTracks(tracksToRemove).catch(console.warn)

	tracker.sendMsg(true)
}

export const workerAction = async (options: TracksScanOptions) => {
	if (options.action === 'directory-add') {
		const handles = await getFileHandlesRecursively(options.dirHandle)
		await scanNewDirectory(handles, options.dirId)

		return
	}

	if (options.action === 'directory-rescan') {
		const handles = await getFileHandlesRecursively(options.dirHandle)
		await scanExistingDirectory(handles, options.dirId)

		return
	}

	if (options.action === 'server-directory-add' || options.action === 'server-directory-rescan') {
		// The catalog is fetched before any database write: on failure existing
		// records stay untouched and the worker reports the error to the UI.
		// A rescan first asks the server to refresh its index (idempotent 202)
		// and polls the scan status so the UI shows real server progress.
		if (options.action === 'server-directory-rescan') {
			await requestServerLibraryRescan()
			await waitForServerLibraryScan({ onProgress: postServerScanProgress })
		}

		const catalog = await fetchCatalogAfterScan()
		await scanServerCatalog(catalog, options.dirId)

		return
	}

	if (options.action === 'legacy-files-add') {
		await scanExistingDirectory(options.files, LEGACY_NO_NATIVE_DIRECTORY)
	}
}
