import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { type IAudioMetadata, parseFile } from 'music-metadata'
import { fixLegacyTagEncoding } from '../../src/lib/library/metadata-encoding.ts'
import {
	CURRENT_METADATA_VERSION,
	type ParsedTrackData,
	UNKNOWN_ITEM,
} from '../../src/lib/library/types.ts'
import type { ServerFileDescriptor } from '../../src/lib/server-library/api.ts'
import type { LibraryIndexStore, PendingTrack, ScanResult } from './index-store.ts'
import { collectAudioFiles, resolveMusicDir } from './walk.ts'

/** Parse options mirror the browser scanner (steps/parse-track-metadata.ts) exactly. */
const PARSE_OPTIONS = {
	duration: true,
	mkvUseIndex: true,
	skipPostHeaders: true,
} as const

const ARTIST_SEPARATOR_RE = /,|&/

const sha256Hex = (input: string | Uint8Array): string =>
	createHash('sha256').update(input).digest('hex')

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

/** Known-safe scan failure message; anything else is reported with a generic one. */
class ScanFailure extends Error {}

const createStableTrackUuid = (path: string): string => `server:${sha256Hex(path)}`

/**
 * Maps `music-metadata` tags to the browser `ParsedTrackData` shape. Must stay in
 * sync with `src/lib/library/scan-actions/scanner/steps/parse-track-metadata.ts`,
 * so a track scanned on the server imports identically to a locally parsed one.
 */
const toParsedTrackData = (
	fileName: string,
	metadata: IAudioMetadata,
): { data: ParsedTrackData; imageBytes?: Uint8Array; imageFormat?: string } => {
	const { common, format } = metadata

	const artists =
		common.artists
			?.flatMap((artist) => artist.split(ARTIST_SEPARATOR_RE))
			.map((artist) => fixLegacyTagEncoding(artist.trim())) ?? []

	const picture = common.picture?.[0]

	const data: ParsedTrackData = {
		// Tag text only: file names and JSON transport are proper Unicode and stay as-is.
		name: common.title ? fixLegacyTagEncoding(common.title) : fileName,
		album: common.album === undefined ? UNKNOWN_ITEM : fixLegacyTagEncoding(common.album),
		artists: artists.length > 0 ? artists : [UNKNOWN_ITEM],
		genre: (common.genre || []).map(fixLegacyTagEncoding),
		trackNo: common.track.no ?? 0,
		trackOf: common.track.of ?? 0,
		discNo: common.disk.no ?? 0,
		discOf: common.disk.of ?? 0,
		year: common.year?.toString() ?? UNKNOWN_ITEM,
		duration: format.duration ?? 0,
		language: common.language?.trim(),
		metadataVersion: CURRENT_METADATA_VERSION,
		format: {
			codec: format.codec ?? '',
		},
	}

	return {
		data,
		imageBytes: picture?.data,
		imageFormat: picture?.format,
	}
}

const toPendingTrack = (file: ServerFileDescriptor, metadata: IAudioMetadata): PendingTrack => {
	const { data, imageBytes, imageFormat } = toParsedTrackData(file.name, metadata)

	let artwork: PendingTrack['artwork']
	if (imageBytes !== undefined && imageBytes.byteLength > 0 && imageFormat !== undefined) {
		artwork = {
			hash: sha256Hex(imageBytes),
			mimeType: imageFormat,
			bytes: Buffer.from(imageBytes),
		}
	}

	return {
		descriptor: file,
		uuid: createStableTrackUuid(file.path),
		data,
		artwork,
	}
}

/** Runs `worker` over `items` with at most `limit` in-flight calls. */
const runWithConcurrency = async (
	items: ServerFileDescriptor[],
	limit: number,
	worker: (item: ServerFileDescriptor) => Promise<void>,
): Promise<void> => {
	let nextIndex = 0

	const lane = async (): Promise<void> => {
		while (nextIndex < items.length) {
			const item = items[nextIndex]
			nextIndex += 1
			if (item === undefined) {
				return
			}
			await worker(item)
		}
	}

	const lanes: Promise<void>[] = []
	for (let laneIndex = 0; laneIndex < Math.min(limit, items.length); laneIndex += 1) {
		lanes.push(lane())
	}
	await Promise.all(lanes)
}

/** @public */
export interface LibraryScannerStatus {
	state: 'scanning' | 'ready' | 'error'
	current: number
	total: number
	error?: string
}

/** @public */
export interface LibraryScanner {
	/**
	 * Starts a scan unless one is already running. Returns `false` when a scan is in
	 * flight (rescan stays idempotent). The scan itself never rejects: failures move
	 * the scanner to the `error` state and keep the previous index.
	 */
	startScan: () => boolean
	/** Kicks the initial background scan once, when the index has never been built. */
	ensureStarted: () => void
	getStatus: () => LibraryScannerStatus
	/** Resolves once no scan is running; a test seam on top of HTTP status polling. */
	waitForIdle: () => Promise<void>
}

/** @public */
export interface LibraryScannerOptions {
	getMusicDir: () => string | undefined
	getStore: () => LibraryIndexStore
	/** Max concurrent metadata parses, already clamped to 1–16. */
	concurrency: number
}

/**
 * Persistent incremental music index scanner (CONTRACTS.md §10). Revalidates by
 * `path + size + lastModified` so unchanged files are never parsed again; changed
 * files are parsed once on the server with `music-metadata.parseFile` (imported at
 * module level, so tests can `vi.mock('music-metadata')`). Deletions are applied
 * only after a fully successful directory walk.
 * @public
 */
export const createLibraryScanner = (options: LibraryScannerOptions): LibraryScanner => {
	const { getMusicDir, getStore, concurrency } = options

	type Phase = 'idle' | 'scanning' | 'ready' | 'error'
	let phase: Phase = 'idle'
	let current = 0
	let total = 0
	let lastError: string | undefined
	let running: Promise<void> | undefined

	const scan = async (): Promise<void> => {
		const musicDir = getMusicDir()
		if (musicDir === undefined) {
			phase = 'ready'
			return
		}

		const store = getStore()
		const realDir = await resolveMusicDir(musicDir)
		if (realDir === undefined) {
			throw new ScanFailure('Music directory is unavailable')
		}

		// Throws when a directory cannot be read: the previous index is preserved untouched
		const files = await collectAudioFiles(realDir)

		const stamps = store.getTrackStamps()
		const forceReparse = store.getMetadataVersion() !== CURRENT_METADATA_VERSION

		const seenPaths = new Set<string>()
		const toParse: ServerFileDescriptor[] = []
		let processed = 0

		for (const file of files) {
			seenPaths.add(file.path)
			const previous = stamps.get(file.path)
			if (
				!forceReparse &&
				previous?.size === file.size &&
				previous.lastModified === file.lastModified
			) {
				processed += 1
				continue
			}
			toParse.push(file)
		}

		total = files.length
		current = processed

		const upserts: PendingTrack[] = []
		const removePaths: string[] = []

		await runWithConcurrency(toParse, concurrency, async (file) => {
			try {
				// `file.path` comes from our own safe walk and always resolves inside `realDir`
				const metadata = await parseFile(
					resolve(realDir, ...file.path.split('/')),
					PARSE_OPTIONS,
				)
				upserts.push(toPendingTrack(file, metadata))
			} catch (error) {
				// Log without secrets; the previous row for a present path is kept, broken new files are skipped
				console.error(
					`[server-library] Failed to parse "${file.path}":`,
					errorMessage(error),
				)
			} finally {
				current += 1
			}
		})

		for (const path of stamps.keys()) {
			if (!seenPaths.has(path)) {
				removePaths.push(path)
			}
		}

		const result: ScanResult = {
			upserts,
			removePaths,
			metadataVersion: CURRENT_METADATA_VERSION,
		}
		store.applyScanResult(result)
		phase = 'ready'
	}

	const startScan = (): boolean => {
		if (running !== undefined) {
			return false
		}

		phase = 'scanning'
		current = 0
		total = 0
		lastError = undefined
		running = scan()
			.catch((error: unknown) => {
				if (error instanceof ScanFailure) {
					lastError = error.message
				} else {
					lastError = 'Music directory could not be scanned'
				}
				console.error('[server-library] Scan failed:', error)
				phase = 'error'
			})
			.finally(() => {
				running = undefined
			})
		return true
	}

	const ensureStarted = (): void => {
		if (phase === 'idle') {
			startScan()
		}
	}

	const getStatus = (): LibraryScannerStatus => {
		const status: LibraryScannerStatus = {
			state: phase === 'idle' ? 'scanning' : phase,
			current,
			total,
		}
		if (lastError !== undefined) {
			status.error = lastError
		}
		return status
	}

	const waitForIdle = async (): Promise<void> => {
		const active = running
		if (active !== undefined) {
			await active
		}
	}

	return { startScan, ensureStarted, getStatus, waitForIdle }
}
