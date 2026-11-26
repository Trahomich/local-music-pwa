/**
 * Reactive mirror of the offline download state for the UI (CONTRACTS.md §12).
 *
 * `downloads.ts` keeps the raw lifecycle in plain module state (it also runs
 * in tests); this module is the Svelte-facing store: it tracks which tracks
 * have an offline copy, whether the copy is current or stale, and what is
 * being downloaded right now. Everything updates through database events and
 * download lifecycle notifications — never through one-shot local booleans.
 *
 * Only record metadata ({@link OfflineTrackRecord} size/lastModified) is kept
 * in memory; blobs always stay in IndexedDB.
 */

import { SvelteMap } from 'svelte/reactivity'
import { onDatabaseChange } from '#lib/db/events.ts'
import { isServerFileEntity } from '#lib/helpers/file-system.ts'
import type { Track } from '#lib/library/types.ts'
import {
	type ActiveBatchInfo,
	getActiveBatch,
	getTrackDownloadError,
	isTrackDownloadActive,
	subscribeDownloads,
} from './downloads.ts'
import { getOfflineTrack, listOfflineTrackUuids, type OfflineTrackRecord } from './store.ts'

export type TrackDownloadStatus = 'downloading' | 'downloaded' | 'stale' | 'error'

/** Freshness metadata copied from {@link OfflineTrackRecord}; no blobs here. */
interface OfflineRecordMeta {
	size: number
	lastModified: number
}

const records = new SvelteMap<string, OfflineRecordMeta>()

// Bumped on every downloads.ts lifecycle change, so reading the status below
// re-runs when a download starts or finishes.
let downloadsVersion = $state(0)

let batchInfo = $state<ActiveBatchInfo | null>(null)

let started = false

const rememberRecord = (record: OfflineTrackRecord | undefined): void => {
	if (record) {
		records.set(record.trackUuid, {
			size: record.size,
			lastModified: record.lastModified,
		})
	}
}

const refreshRecord = async (trackUuid: string): Promise<void> => {
	const record = await getOfflineTrack(trackUuid)
	if (record) {
		rememberRecord(record)
	} else {
		records.delete(trackUuid)
	}
}

const ensureStarted = (): void => {
	if (started || import.meta.env.SSR) {
		return
	}
	started = true

	// Initial snapshot; later updates come from database events.
	void listOfflineTrackUuids()
		.then((uuids) => Promise.all(uuids.map((uuid) => getOfflineTrack(uuid))))
		.then((entries) => {
			for (const entry of entries) {
				rememberRecord(entry)
			}
		})

	onDatabaseChange((changes) => {
		for (const change of changes) {
			if (change.storeName === 'offlineTracks') {
				void refreshRecord(String(change.key))
			}
		}
	})

	subscribeDownloads(() => {
		downloadsVersion += 1
		batchInfo = getActiveBatch()
	})

	// A batch may already be running when the UI first subscribes. The read is
	// deferred: ensureStarted() also runs inside a $derived during render
	// (PlaylistDownloadControls on the playlist detail page), where a
	// synchronous $state mutation throws state_unsafe_mutation.
	queueMicrotask(() => {
		batchInfo = getActiveBatch()
	})
}

/**
 * The offline status of a server track:
 * - `'downloading'` — a download is in flight for it;
 * - `'downloaded'` — the offline copy matches the server file;
 * - `'stale'` — a copy exists but the server file changed since;
 * - `'error'` — the last download attempt failed;
 * - `undefined` — no offline copy and nothing going on (or a local track).
 *
 * Reactive: safe to call from `$derived` and templates.
 */
export const getTrackDownloadStatus = (track: Track): TrackDownloadStatus | undefined => {
	ensureStarted()

	if (!isServerFileEntity(track.file)) {
		return undefined
	}

	// Reading the version makes this function re-run on lifecycle changes.
	void downloadsVersion

	if (isTrackDownloadActive(track.uuid)) {
		return 'downloading'
	}

	if (getTrackDownloadError(track.uuid) !== undefined) {
		return 'error'
	}

	const record = records.get(track.uuid)
	if (!record) {
		return undefined
	}

	return record.size === track.file.size && record.lastModified === track.file.lastModified
		? 'downloaded'
		: 'stale'
}

/**
 * The running playlist batch progress (`{playlistId, done, total}`), or null.
 * Reactive; use it for the playlist detail progress UI.
 */
export const getBatchProgress = (): ActiveBatchInfo | null => {
	ensureStarted()

	return batchInfo
}
