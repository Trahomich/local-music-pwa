// @vitest-environment node

// Контракт: CONTRACTS.md §10 — серверный индекс (#14) применяет fixLegacyTagEncoding
// (#26) в toParsedTrackData: catalog отдаёт корректную кириллицу для legacy
// CP1251/UTF-8-as-Latin-1 тегов и не портит UTF-16/UTF-8/Latin-1 и имена файлов.
// Независимые regression-тесты (#27), фикстуры генерируются программно.
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	buildLegacyMp3,
	buildUntaggedMp3,
} from '../../src/lib/library/__tests__/tag-encoding-fixtures.ts'
import { CURRENT_METADATA_VERSION, UNKNOWN_ITEM } from '../../src/lib/library/types.ts'
import { createServerLibraryMiddleware } from '../library/middleware.ts'

const API_ROOT = '/api/server-library'

interface CatalogTrackData {
	name: string
	album: string
	artists: string[]
	genre: string[]
	metadataVersion: number
}

interface CatalogResponse {
	revision: number
	tracks: {
		descriptor: { path: string }
		data: CatalogTrackData
	}[]
}

describe('server catalog legacy tag encodings (#26 regression)', () => {
	let sandbox: string
	let musicDir: string
	let server: Server | undefined
	let origin: string
	let catalog: CatalogResponse
	let catalogRawBody: string
	let catalogContentType: string

	const trackByPath = (path: string): CatalogTrackData => {
		const track = catalog.tracks.find((entry) => entry.descriptor.path === path)
		expect(track, `catalog must contain ${path}`).toBeDefined()
		return (track as { data: CatalogTrackData }).data
	}

	beforeAll(async () => {
		sandbox = await mkdtemp(join(tmpdir(), 'snae-encoding-test-'))
		musicDir = join(sandbox, 'music')
		const dataDir = join(sandbox, 'data')
		await mkdir(musicDir, { recursive: true })

		const fixtures: [string, Uint8Array][] = [
			[
				'cp1251.mp3',
				buildLegacyMp3({
					title: { text: 'Группа крови', encoding: 'cp1251' },
					artist: { text: 'Кино', encoding: 'cp1251' },
					album: { text: 'Звезда по имени Солнце', encoding: 'cp1251' },
					genre: { text: 'Рок', encoding: 'cp1251' },
				}),
			],
			[
				'utf8-as-latin1.mp3',
				buildLegacyMp3({
					title: { text: 'Группа крови', encoding: 'utf8-as-latin1' },
					artist: { text: 'Кино', encoding: 'utf8-as-latin1' },
				}),
			],
			[
				'utf16.mp3',
				buildLegacyMp3({
					title: { text: 'Группа крови', encoding: 'utf16' },
					artist: { text: 'Кино', encoding: 'utf16' },
				}),
			],
			[
				'utf8-v24.mp3',
				buildLegacyMp3({
					title: { text: 'Группа крови', encoding: 'utf8' },
					artist: { text: 'Кино', encoding: 'utf8' },
				}),
			],
			[
				'mixed-cp1251.mp3',
				buildLegacyMp3({
					title: { text: 'Песня без слов (live)', encoding: 'cp1251' },
					artist: { text: 'Кино', encoding: 'cp1251' },
				}),
			],
			[
				'latin1.mp3',
				buildLegacyMp3({
					title: { text: 'Café del Mar', encoding: 'latin1' },
					artist: { text: 'Éléonore', encoding: 'latin1' },
				}),
			],
			// Tagless file: name must fall back to the (proper Unicode) file name, untouched.
			['Кино — Группа крови.mp3', buildUntaggedMp3()],
		]
		for (const [name, bytes] of fixtures) {
			await writeFile(join(musicDir, name), bytes)
		}

		const middleware = createServerLibraryMiddleware(() => musicDir, { dataDir })
		server = createServer((req, res) => {
			void middleware(req, res, () => {
				res.writeHead(404)
				res.end('next')
			})
		})
		server.listen(0, '127.0.0.1')
		await once(server, 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') {
			throw new Error('Test server did not expose a TCP port')
		}
		origin = `http://127.0.0.1:${address.port}`

		// Детерминированное ожидание конца startup scan через test seam.
		await middleware.waitForScanIdle()

		const response = await fetch(`${origin}${API_ROOT}/catalog`)
		expect(response.status).toBe(200)
		catalogContentType = response.headers.get('content-type') ?? ''
		catalogRawBody = await response.text()
		catalog = JSON.parse(catalogRawBody) as CatalogResponse
	}, 60_000)

	afterAll(async () => {
		if (server?.listening) {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => (error ? reject(error) : resolve()))
			})
		}
		server = undefined
		await rm(sandbox, { force: true, recursive: true })
	})

	it('serves the catalog as UTF-8 JSON without replacement characters', () => {
		expect(catalogContentType).toContain('application/json')
		expect(catalogRawBody).not.toContain('�')
	})

	it('repairs CP1251 tags mislabeled as ISO-8859-1', () => {
		const data = trackByPath('cp1251.mp3')
		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
		expect(data.album).toBe('Звезда по имени Солнце')
		expect(data.genre).toEqual(['Рок'])
		expect(data.metadataVersion).toBe(CURRENT_METADATA_VERSION)
	})

	it('repairs UTF-8 bytes mislabeled as ISO-8859-1', () => {
		const data = trackByPath('utf8-as-latin1.mp3')
		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
	})

	it('keeps UTF-16 ID3v2.3 tags as parsed', () => {
		const data = trackByPath('utf16.mp3')
		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
	})

	it('keeps UTF-8 ID3v2.4 tags as parsed', () => {
		const data = trackByPath('utf8-v24.mp3')
		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
	})

	it('repairs a mixed Cyrillic/Latin CP1251 title', () => {
		const data = trackByPath('mixed-cp1251.mp3')
		expect(data.name).toBe('Песня без слов (live)')
		expect(data.artists).toEqual(['Кино'])
	})

	it('keeps legitimate Latin-1 tags untouched', () => {
		const data = trackByPath('latin1.mp3')
		expect(data.name).toBe('Café del Mar')
		expect(data.artists).toEqual(['Éléonore'])
	})

	it('falls back to the proper-Unicode file name for tagless files', () => {
		const data = trackByPath('Кино — Группа крови.mp3')
		expect(data.name).toBe('Кино — Группа крови.mp3')
		expect(data.artists).toEqual([UNKNOWN_ITEM])
	})
})
