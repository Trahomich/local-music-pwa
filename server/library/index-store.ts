import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ParsedTrackData } from '../../src/lib/library/types.ts'
import type { ServerCatalogTrack, ServerFileDescriptor } from '../../src/lib/server-library/api.ts'

/** Artwork bytes of a single track, addressed by the SHA-256 hex of the image bytes. */
/** @public */
export interface PendingArtwork {
	hash: string
	mimeType: string
	bytes: Uint8Array
}

/** A fully parsed track ready to be persisted in the index. */
/** @public */
export interface PendingTrack {
	descriptor: ServerFileDescriptor
	uuid: string
	data: ParsedTrackData
	artwork?: PendingArtwork
}

/** Result of one fully completed scan, applied to the index in a single transaction. */
/** @public */
export interface ScanResult {
	/** New and changed tracks (unchanged rows stay untouched). */
	upserts: PendingTrack[]
	/** Paths that disappeared from the music directory. */
	removePaths: string[]
	metadataVersion: number
}

/** @public */
export interface StoredArtwork {
	mimeType: string
	bytes: Uint8Array
}

/** @public */
export interface TrackStamp {
	size: number
	lastModified: number
}

/** @public */
export interface LibraryIndexStore {
	/** Current stamps of all indexed tracks, for incremental revalidation. */
	getTrackStamps: () => Map<string, TrackStamp>
	/** Metadata schema version the index was built with, or `undefined` on a fresh index. */
	getMetadataVersion: () => number | undefined
	/** Whether at least one scan completed successfully (a servable catalog exists). */
	hasCompleteIndex: () => boolean
	getRevision: () => number
	/** Complete catalog of the last finished scan, sorted by path. */
	getCatalog: () => ServerCatalogTrack[]
	getArtwork: (hash: string) => StoredArtwork | undefined
	/** Applies a completed scan atomically; bumps the revision only when the index changed. */
	applyScanResult: (result: ScanResult) => void
	close: () => void
}

/** Runs `migration` inside a transaction and records its schema version. */
const migrateTo = (db: DatabaseSync, version: number, migrate: () => void): void => {
	const current = (db.prepare('PRAGMA user_version').get() as { user_version: number })
		.user_version
	if (current >= version) {
		return
	}

	db.exec('BEGIN IMMEDIATE')
	try {
		migrate()
		db.exec(`PRAGMA user_version = ${version}`)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

interface TrackRow {
	path: string
	name: string
	size: number
	last_modified: number
	uuid: string
	data: string
	artwork_hash: string | null
	artwork_mime: string | null
}

/**
 * Opens (creating if needed) `library.sqlite` inside `dataDir` and applies the index schema.
 * The index is the single source of the catalog and survives restarts (CONTRACTS.md §10);
 * nothing is ever written into MUSIC_DIR.
 * @public
 */
export const createLibraryIndexStore = (dataDir: string): LibraryIndexStore => {
	mkdirSync(dataDir, { recursive: true })
	const db = new DatabaseSync(resolve(dataDir, 'library.sqlite'))
	db.exec('PRAGMA journal_mode = WAL')
	db.exec('PRAGMA busy_timeout = 5000')

	migrateTo(db, 1, () => {
		db.exec(`
			CREATE TABLE meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE tracks (
				path TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				size INTEGER NOT NULL,
				last_modified INTEGER NOT NULL,
				uuid TEXT NOT NULL,
				data TEXT NOT NULL,
				artwork_hash TEXT
			);
			CREATE TABLE artwork (
				hash TEXT PRIMARY KEY,
				mime_type TEXT NOT NULL,
				bytes BLOB NOT NULL
			);
		`)
	})

	const getMeta = (key: string): string | undefined =>
		(
			db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
				| { value: string }
				| undefined
		)?.value

	const setMeta = (key: string, value: string): void => {
		db.prepare(
			'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		).run(key, value)
	}

	const getTrackStamps = (): Map<string, TrackStamp> => {
		const rows = db.prepare('SELECT path, size, last_modified FROM tracks').all() as {
			path: string
			size: number
			last_modified: number
		}[]
		return new Map(
			rows.map((row) => [row.path, { size: row.size, lastModified: row.last_modified }]),
		)
	}

	const getMetadataVersion = (): number | undefined => {
		const raw = getMeta('metadata_version')
		if (raw === undefined) {
			return undefined
		}
		const parsed = Number(raw)
		return Number.isInteger(parsed) ? parsed : undefined
	}

	const hasCompleteIndex = (): boolean => getMeta('complete') === '1'

	const getRevision = (): number => {
		const parsed = Number(getMeta('revision'))
		return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
	}

	const getCatalog = (): ServerCatalogTrack[] => {
		const rows = db
			.prepare(
				`SELECT tracks.path, tracks.name, tracks.size, tracks.last_modified, tracks.uuid, tracks.data,
				        tracks.artwork_hash, artwork.mime_type AS artwork_mime
				 FROM tracks LEFT JOIN artwork ON artwork.hash = tracks.artwork_hash
				 ORDER BY tracks.path`,
			)
			.all() as TrackRow[]

		return rows.map((row) => ({
			descriptor: {
				path: row.path,
				name: row.name,
				size: row.size,
				lastModified: row.last_modified,
			},
			uuid: row.uuid,
			data: JSON.parse(row.data) as ParsedTrackData,
			...(row.artwork_hash !== null && row.artwork_mime !== null
				? { artwork: { hash: row.artwork_hash, mimeType: row.artwork_mime } }
				: {}),
		}))
	}

	const getArtwork = (hash: string): StoredArtwork | undefined => {
		const row = db.prepare('SELECT mime_type, bytes FROM artwork WHERE hash = ?').get(hash) as
			| { mime_type: string; bytes: Uint8Array }
			| undefined
		return row === undefined ? undefined : { mimeType: row.mime_type, bytes: row.bytes }
	}

	const applyScanResult = (result: ScanResult): void => {
		const complete = hasCompleteIndex()
		const versionChanged = getMetadataVersion() !== result.metadataVersion
		const changed =
			!complete ||
			versionChanged ||
			result.upserts.length > 0 ||
			result.removePaths.length > 0

		db.exec('BEGIN IMMEDIATE')
		try {
			const upsertTrack = db.prepare(
				`INSERT INTO tracks (path, name, size, last_modified, uuid, data, artwork_hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
					name = excluded.name,
					size = excluded.size,
					last_modified = excluded.last_modified,
					uuid = excluded.uuid,
					data = excluded.data,
					artwork_hash = excluded.artwork_hash`,
			)
			const insertArtwork = db.prepare(
				'INSERT OR IGNORE INTO artwork (hash, mime_type, bytes) VALUES (?, ?, ?)',
			)

			for (const track of result.upserts) {
				if (track.artwork !== undefined) {
					insertArtwork.run(
						track.artwork.hash,
						track.artwork.mimeType,
						track.artwork.bytes,
					)
				}
				upsertTrack.run(
					track.descriptor.path,
					track.descriptor.name,
					track.descriptor.size,
					track.descriptor.lastModified,
					track.uuid,
					JSON.stringify(track.data),
					track.artwork?.hash ?? null,
				)
			}

			const deleteTrack = db.prepare('DELETE FROM tracks WHERE path = ?')
			for (const path of result.removePaths) {
				deleteTrack.run(path)
			}

			// Drop artwork no track references anymore
			db.exec(
				`DELETE FROM artwork WHERE hash NOT IN (
					SELECT artwork_hash FROM tracks WHERE artwork_hash IS NOT NULL
				)`,
			)

			if (changed) {
				setMeta('revision', String(getRevision() + 1))
			}
			setMeta('metadata_version', String(result.metadataVersion))
			setMeta('complete', '1')
			db.exec('COMMIT')
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	}

	return {
		getTrackStamps,
		getMetadataVersion,
		hasCompleteIndex,
		getRevision,
		getCatalog,
		getArtwork,
		applyScanResult,
		close: () => {
			db.close()
		},
	}
}
