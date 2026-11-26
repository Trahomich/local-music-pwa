import type { Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getAudioMimeType, type ServerFileDescriptor } from '../../src/lib/server-library/api.ts'

/** @public */
export const isErrorCode = (error: unknown, code: string): boolean =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === code

/** Resolves `MUSIC_DIR` to its real path, or `undefined` when it is not a readable directory. */
/** @public */
export const resolveMusicDir = async (musicDir: string): Promise<string | undefined> => {
	try {
		const [realDir, dirStat] = await Promise.all([realpath(musicDir), stat(musicDir)])
		return dirStat.isDirectory() ? realDir : undefined
	} catch {
		return undefined
	}
}

/**
 * Recursively lists supported regular audio files under `rootDir`, sorted by path.
 * Never follows symbolic links; files disappearing mid-walk are skipped.
 * Throws when a directory cannot be read, so callers never see a partial index.
 * @public
 */
export const collectAudioFiles = async (rootDir: string): Promise<ServerFileDescriptor[]> => {
	const files: ServerFileDescriptor[] = []

	const walk = async (directory: string, segments: string[]): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true })

		for (const entry of entries) {
			// Never follow symbolic links, neither to files nor to directories
			if (entry.isSymbolicLink()) {
				continue
			}

			if (entry.isDirectory()) {
				await walk(resolve(directory, entry.name), [...segments, entry.name])
				continue
			}

			if (!entry.isFile() || getAudioMimeType(entry.name) === undefined) {
				continue
			}

			let fileStat: Stats
			try {
				fileStat = await stat(resolve(directory, entry.name))
			} catch (error) {
				// The file may disappear between readdir and stat; skip it instead of failing the whole index
				if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTDIR')) {
					continue
				}
				throw error
			}

			files.push({
				path: [...segments, entry.name].join('/'),
				name: entry.name,
				size: fileStat.size,
				lastModified: Math.round(fileStat.mtimeMs),
			})
		}
	}

	await walk(rootDir, [])
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	return files
}
