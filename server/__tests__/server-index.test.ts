// @vitest-environment node
/**
 * Независимые тесты серверного музыкального индекса по §10 CONTRACTS.md (#20).
 * Реализация — #14 (Иван Петров): createServerLibraryMiddleware(getMusicDir?, {dataDir?, scanConcurrency?}),
 * seam waitForScanIdle(), parseFile — верхнеуровневый импорт из 'music-metadata' в scanner.ts.
 *
 * Фикстуры генерируются программно (audio-fixtures.ts), реальные audio-файлы не нужны.
 */

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_METADATA_VERSION } from '../../src/lib/library/types.ts'
// Фабрика индекс-middleware из #14 (согласованная сигнатура, пост #42 в #14)
import { createServerLibraryMiddleware } from '../library/middleware.ts'
import { buildCorruptAudio, buildMp3, buildWav, PNG_1PX, PNG_1PX_ALT } from './audio-fixtures.ts'

/** SHA-256 hex digest (artwork hash по §10). */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

/** Счётчик вызовов parseFile с трекингом concurrency и управляемой задержкой. */
const parseTracker = vi.hoisted(() => ({
	calls: 0,
	inFlight: 0,
	maxInFlight: 0,
	delayMs: 0,
	paths: [] as string[],
	reset() {
		this.calls = 0
		this.inFlight = 0
		this.maxInFlight = 0
		this.delayMs = 0
		this.paths = []
	},
}))

vi.mock('music-metadata', async (importOriginal) => {
	const actual = await importOriginal<typeof import('music-metadata')>()
	return {
		...actual,
		parseFile: async (path: string, ...rest: unknown[]) => {
			parseTracker.calls += 1
			parseTracker.inFlight += 1
			parseTracker.maxInFlight = Math.max(parseTracker.maxInFlight, parseTracker.inFlight)
			parseTracker.paths.push(String(path))
			try {
				if (parseTracker.delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, parseTracker.delayMs))
				}
				// @ts-expect-error — проксируем сигнатуру как есть
				return await actual.parseFile(path, ...rest)
			} finally {
				parseTracker.inFlight -= 1
			}
		},
	}
})

const API_ROOT = '/api/server-library'
const STATUS_URL = `${API_ROOT}/status`
const CATALOG_URL = `${API_ROOT}/catalog`
const RESCAN_URL = `${API_ROOT}/rescan`
const ARTWORK_URL = `${API_ROOT}/artwork`

interface CatalogTrack {
	descriptor: { path: string; name: string; size: number; lastModified: number }
	uuid: string
	data: {
		name: string
		album: string
		artists: string[]
		genre: string[]
		year: string
		duration: number
		trackNo: number
		metadataVersion: number
		format: { codec: string }
	}
	artwork?: { hash: string; mimeType: string }
}

interface CatalogResponse {
	revision: number
	tracks: CatalogTrack[]
}

interface StatusResponse {
	enabled: boolean
	state?: 'scanning' | 'ready' | 'error'
	current?: number
	total?: number
	error?: string
}

const sha256Hex = (input: string | Buffer): string =>
	createHash('sha256').update(input).digest('hex')

const expectedServerUuid = (relativePath: string): string => `server:${sha256Hex(relativePath)}`

describe('server music index (§10)', () => {
	let sandbox: string
	let musicDir: string
	let dataDir: string
	let server: Server | undefined
	let origin: string

	const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init)

	const getStatus = async (): Promise<StatusResponse> => {
		const response = await request(STATUS_URL)
		expect(response.status).toBe(200)
		return (await response.json()) as StatusResponse
	}

	const getCatalog = async (): Promise<{
		status: number
		body: CatalogResponse | { error: { code: string } }
	}> => {
		const response = await request(CATALOG_URL)
		return { status: response.status, body: (await response.json()) as CatalogResponse }
	}

	const postRescan = () => request(RESCAN_URL, { method: 'POST' })

	const waitForState = async (
		state: 'ready' | 'error',
		timeoutMs = 30_000,
	): Promise<StatusResponse> => {
		const deadline = Date.now() + timeoutMs
		let last: StatusResponse | undefined
		while (Date.now() < deadline) {
			last = await getStatus()
			if (last.state === state) {
				return last
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		throw new Error(
			`Timed out waiting for state '${state}', last status: ${JSON.stringify(last)}`,
		)
	}

	/** Ждёт готовности и возвращает catalog; падает, если тот не 200. */
	const waitForCatalog = async (timeoutMs = 30_000): Promise<CatalogResponse> => {
		await waitForState('ready', timeoutMs)
		const { status, body } = await getCatalog()
		expect(status).toBe(200)
		return body as CatalogResponse
	}

	const writeFixture = async (relativePath: string, content: Buffer) => {
		const absolutePath = join(musicDir, relativePath)
		await mkdir(dirname(absolutePath), { recursive: true })
		await writeFile(absolutePath, content)
		return absolutePath
	}

	const trackByPath = (catalog: CatalogResponse, path: string): CatalogTrack => {
		const track = catalog.tracks.find((entry) => entry.descriptor.path === path)
		expect(track, `catalog must contain ${path}`).toBeDefined()
		return track as CatalogTrack
	}

	/** Создание индекс-middleware #14 (согласованная сигнатура) и монтирование в HTTP-сервер. */
	let middleware: ReturnType<typeof createServerLibraryMiddleware> | undefined
	const createIndexServer = async (options: {
		musicDir?: string
		dataDir?: string
		scanConcurrency?: number
	}) => {
		middleware = createServerLibraryMiddleware(() => options.musicDir, {
			dataDir: options.dataDir,
			...(options.scanConcurrency === undefined
				? {}
				: { scanConcurrency: options.scanConcurrency }),
		})
		server = createServer((req, res) => {
			void middleware?.(req, res, () => {
				res.writeHead(404)
				res.end('next')
			})
		})
		server.listen(0, '127.0.0.1')
		await once(server, 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') {
			throw new Error('no TCP port')
		}
		origin = `http://127.0.0.1:${address.port}`
	}

	/** Детерминированное ожидание конца scan через test seam (без HTTP-polling). */
	const waitForScanIdle = async () => {
		expect(middleware, 'middleware must be created').toBeDefined()
		await middleware?.waitForScanIdle()
	}

	const closeServer = async () => {
		if (server?.listening) {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => (error ? reject(error) : resolve()))
			})
		}
		server = undefined
	}

	beforeEach(async () => {
		parseTracker.reset()
		sandbox = await mkdtemp(join(tmpdir(), 'snae-index-test-'))
		musicDir = join(sandbox, 'music')
		dataDir = join(sandbox, 'data')
		await mkdir(musicDir)
		await mkdir(dataDir)
	})

	afterEach(async () => {
		await closeServer()
		// на случай тестов с chmod 000 — вернуть права до удаления
		await chmod(join(musicDir, 'locked'), 0o700).catch(() => {})
		await rm(sandbox, { force: true, recursive: true })
	})

	it('runs a startup scan with visible progress and publishes the catalog', async () => {
		// широкое окно scan (400мс/файл), чтобы гарантированно поймать состояние scanning
		// даже под нагрузкой на общей машине
		parseTracker.delayMs = 400
		await writeFixture('Artist/a.wav', buildWav({ tags: { INAM: 'A' } }))
		await writeFixture('Artist/b.wav', buildWav({ tags: { INAM: 'B' } }))
		await writeFixture('c.wav', buildWav({ tags: { INAM: 'C' } }))

		await createIndexServer({ musicDir, dataDir })

		// во время первого scan catalog обязан отвечать 409 SCAN_IN_PROGRESS
		const during = await getCatalog()
		expect(during.status).toBe(409)
		expect((during.body as { error: { code: string } }).error.code).toBe('SCAN_IN_PROGRESS')

		const scanning = await getStatus()
		expect(scanning.enabled).toBe(true)
		expect(scanning.state).toBe('scanning')
		expect(scanning.total).toBe(3)
		expect(scanning.current ?? 0).toBeLessThanOrEqual(3)

		const catalog = await waitForCatalog()
		expect(catalog.tracks).toHaveLength(3)
		expect(parseTracker.calls).toBe(3)
	})

	it('normalizes metadata and assigns stable server uuids', async () => {
		await writeFixture(
			'Artist/Album/song.wav',
			buildWav({
				seconds: 2,
				tags: {
					INAM: 'Song One',
					IART: 'Artist A',
					IPRD: 'Album X',
					IGNR: 'Rock',
					ICRD: '2021',
					ITRK: '3',
				},
			}),
		)
		await writeFixture('plain.wav', buildWav({ seconds: 1 }))

		await createIndexServer({ musicDir, dataDir })
		const catalog = await waitForCatalog()

		const song = trackByPath(catalog, 'Artist/Album/song.wav')
		expect(song.uuid).toBe(expectedServerUuid('Artist/Album/song.wav'))
		expect(song.data.name).toBe('Song One')
		expect(song.data.album).toBe('Album X')
		expect(song.data.artists).toEqual(['Artist A'])
		expect(song.data.genre).toEqual(['Rock'])
		expect(song.data.year).toBe('2021')
		expect(song.data.trackNo).toBe(3)
		expect(song.data.duration).toBeGreaterThan(1.5)
		expect(song.data.duration).toBeLessThan(2.5)
		expect(song.data.metadataVersion).toBe(CURRENT_METADATA_VERSION)
		expect(song.data.format.codec).toBe('PCM')

		const fileStat = await stat(join(musicDir, 'Artist/Album/song.wav'))
		expect(song.descriptor.size).toBe(fileStat.size)
		expect(song.descriptor.lastModified).toBe(Math.round(fileStat.mtimeMs))
		expect(song.descriptor.name).toBe('song.wav')

		// fallback без тегов: имя из файла, unknown-поля по правилам клиентского парсера
		const plain = trackByPath(catalog, 'plain.wav')
		expect(plain.data.name).toBe('plain.wav')
		expect(plain.uuid).toBe(expectedServerUuid('plain.wav'))
	})

	it('does not reparse unchanged files on rescan (incremental index)', async () => {
		await writeFixture('a.wav', buildWav({ tags: { INAM: 'A' } }))
		await writeFixture('b.wav', buildWav({ tags: { INAM: 'B' } }))
		await createIndexServer({ musicDir, dataDir })
		await waitForCatalog()
		expect(parseTracker.calls).toBe(2)

		const rescanResponse = await postRescan()
		expect(rescanResponse.status).toBe(202)
		await expect(rescanResponse.json()).resolves.toEqual({ state: 'scanning' })
		// детерминированное ожидание через согласованный seam вместо HTTP-polling
		await waitForScanIdle()

		// unchanged path+size+lastModified → parseFile не вызывается повторно
		expect(parseTracker.calls).toBe(2)
	})

	it('reparses only changed files and removes deleted ones after a complete walk', async () => {
		const pathA = await writeFixture('a.wav', buildWav({ tags: { INAM: 'A' } }))
		await writeFixture('b.wav', buildWav({ tags: { INAM: 'B' } }))
		await createIndexServer({ musicDir, dataDir })
		const first = await waitForCatalog()
		expect(first.tracks).toHaveLength(2)

		// меняем a.wav (другой размер), удаляем b.wav, добавляем c.wav
		await writeFile(pathA, buildWav({ seconds: 3, tags: { INAM: 'A2' } }))
		await rm(join(musicDir, 'b.wav'))
		await writeFixture('c.wav', buildWav({ tags: { INAM: 'C' } }))

		parseTracker.reset()
		await postRescan()
		const catalog = await waitForCatalog()

		expect(catalog.tracks.map((t) => t.descriptor.path).sort()).toEqual(['a.wav', 'c.wav'])
		expect(trackByPath(catalog, 'a.wav').data.name).toBe('A2')
		// перепарсились только a.wav и c.wav
		expect(parseTracker.calls).toBe(2)
		// uuid стабилен для неизменного пути
		expect(trackByPath(catalog, 'a.wav').uuid).toBe(expectedServerUuid('a.wav'))
	})

	it('keeps the previous record when a single file fails to parse', async () => {
		// mp3, потому что битая ID3-фикстура стабильно бросает именно для mp3-сигнатур
		const pathA = await writeFixture(
			'a.mp3',
			buildMp3({ tags: { title: 'Good A' }, image: null }),
		)
		await createIndexServer({ musicDir, dataDir })
		const first = await waitForCatalog()
		expect(trackByPath(first, 'a.mp3').data.name).toBe('Good A')

		// заменяем содержимое на битое (тот же path, другой size/mtime)
		await writeFile(pathA, buildCorruptAudio())
		await writeFixture('broken-new.mp3', buildCorruptAudio())

		await postRescan()
		const status = await waitForState('ready')
		expect(status.state).toBe('ready')

		const catalog = await waitForCatalog()
		// прежняя запись для присутствующего path сохранена
		expect(trackByPath(catalog, 'a.mp3').data.name).toBe('Good A')
		// новый битый файл пропущен
		expect(catalog.tracks.some((t) => t.descriptor.path === 'broken-new.mp3')).toBe(false)
	})

	it('keeps the previous index and reports error when a directory cannot be read', async () => {
		await writeFixture('ok.wav', buildWav({ tags: { INAM: 'Ok' } }))
		const lockedDir = join(musicDir, 'locked')
		await mkdir(lockedDir)
		await writeFile(join(lockedDir, 'inner.wav'), buildWav({ tags: { INAM: 'Inner' } }))

		await createIndexServer({ musicDir, dataDir })
		const first = await waitForCatalog()
		expect(first.tracks.map((t) => t.descriptor.path).sort()).toEqual([
			'locked/inner.wav',
			'ok.wav',
		])

		// удаляем ok.wav И делаем подкаталог нечитаемым: обход падает,
		// поэтому удаление ok.wav НЕ должно примениться
		await rm(join(musicDir, 'ok.wav'))
		await chmod(lockedDir, 0o000)
		try {
			await postRescan()
			const status = await waitForState('error')
			expect(status.state).toBe('error')
			// ошибка не раскрывает host path
			expect(JSON.stringify(status)).not.toContain(sandbox)
		} finally {
			await chmod(lockedDir, 0o700)
		}

		// после ошибочного scan state остаётся 'error' до следующего rescan,
		// но catalog обязан отдавать последний complete index
		const { status: catalogStatus, body } = await getCatalog()
		expect(catalogStatus).toBe(200)
		const catalog = body as CatalogResponse
		// прежний индекс целиком сохранён
		expect(catalog.tracks.map((t) => t.descriptor.path).sort()).toEqual([
			'locked/inner.wav',
			'ok.wav',
		])
	})

	it('survives restart on the same DATA_DIR without reparsing', async () => {
		await writeFixture('a.wav', buildWav({ tags: { INAM: 'A' } }))
		await writeFixture('deep/nested/b.wav', buildWav({ tags: { INAM: 'B' } }))

		await createIndexServer({ musicDir, dataDir })
		const first = await waitForCatalog()
		expect(parseTracker.calls).toBe(2)
		await closeServer()

		// «перезапуск»: новый экземпляр на том же DATA_DIR
		parseTracker.reset()
		await createIndexServer({ musicDir, dataDir })
		const second = await waitForCatalog()

		expect(parseTracker.calls).toBe(0)
		expect(second.tracks).toEqual(first.tracks)
		expect(second.tracks.map((t) => t.uuid).sort()).toEqual(
			first.tracks.map((t) => t.uuid).sort(),
		)
	})

	it('serves the last complete catalog during a background rescan', async () => {
		await writeFixture('a.wav', buildWav({ tags: { INAM: 'A' } }))
		await createIndexServer({ musicDir, dataDir })
		const first = await waitForCatalog()

		// новый файл + медленный парсер, чтобы гарантированно поймать rescan в середине
		await writeFixture('b.wav', buildWav({ tags: { INAM: 'B' } }))
		parseTracker.delayMs = 500
		await postRescan()

		const during = await getCatalog()
		expect(during.status).toBe(200)
		expect((during.body as CatalogResponse).tracks).toEqual(first.tracks)

		parseTracker.delayMs = 0
		const after = await waitForCatalog()
		expect(after.tracks).toHaveLength(2)
	})

	it('exposes artwork with hash, mime, immutable cache and dedup', async () => {
		await writeFixture('one.mp3', buildMp3({ tags: { title: 'One' }, image: PNG_1PX }))
		await writeFixture('two.mp3', buildMp3({ tags: { title: 'Two' }, image: PNG_1PX }))
		await writeFixture('three.mp3', buildMp3({ tags: { title: 'Three' }, image: PNG_1PX_ALT }))
		await createIndexServer({ musicDir, dataDir })
		const catalog = await waitForCatalog()

		const one = trackByPath(catalog, 'one.mp3')
		const two = trackByPath(catalog, 'two.mp3')
		const three = trackByPath(catalog, 'three.mp3')

		expect(one.artwork).toBeDefined()
		expect(one.artwork?.hash).toMatch(SHA256_HEX_PATTERN)
		expect(one.artwork?.mimeType).toBe('image/png')
		// одинаковые байты → один hash (dedup); разные → разные
		expect(two.artwork?.hash).toBe(one.artwork?.hash)
		expect(three.artwork?.hash).not.toBe(one.artwork?.hash)

		const artworkResponse = await request(`${ARTWORK_URL}/${one.artwork?.hash}`)
		expect(artworkResponse.status).toBe(200)
		expect(artworkResponse.headers.get('content-type')).toBe('image/png')
		// пробелы вокруг запятых незначимы (RFC 7231 OWS), директивы и порядок — строго по §10
		expect(artworkResponse.headers.get('cache-control')?.replaceAll(' ', '')).toBe(
			'public,max-age=31536000,immutable',
		)
		const bytes = Buffer.from(await artworkResponse.arrayBuffer())
		expect(bytes.equals(PNG_1PX)).toBe(true)

		const missing = await request(`${ARTWORK_URL}/${'0'.repeat(64)}`)
		expect(missing.status).toBe(404)
		await expect(missing.json()).resolves.toMatchObject({
			error: { code: 'ARTWORK_NOT_FOUND' },
		})

		// endpoint не принимает path: traversal/мусор не должен ничего отдать
		for (const bad of ['..%2F..%2Fetc', 'not-hex', 'ABCD']) {
			const response = await request(`${ARTWORK_URL}/${bad}`)
			expect([400, 404]).toContain(response.status)
		}
	})

	it('runs rescans single-flight and respects the concurrency limit', async () => {
		for (let i = 0; i < 8; i += 1) {
			await writeFixture(`f${i}.wav`, buildWav({ tags: { INAM: `T${i}` } }))
		}
		await createIndexServer({ musicDir, dataDir, scanConcurrency: 2 })
		await waitForCatalog()
		expect(parseTracker.maxInFlight).toBeLessThanOrEqual(2)

		// меняем все файлы и запускаем два rescan одновременно
		for (let i = 0; i < 8; i += 1) {
			await writeFixture(`f${i}.wav`, buildWav({ seconds: 0.1, tags: { INAM: `T${i}x` } }))
		}
		parseTracker.reset()
		// 8 файлов × 100мс при concurrency 2 ≈ 400мс scan — второй POST гарантированно
		// попадает в single-flight окно даже под нагрузкой
		parseTracker.delayMs = 100

		const [first, second] = await Promise.all([postRescan(), postRescan()])
		expect(first.status).toBe(202)
		expect(second.status).toBe(202)
		await waitForState('ready')

		// один scan на двоих: каждый файл распарсен ровно один раз
		expect(parseTracker.calls).toBe(8)
		expect(parseTracker.maxInFlight).toBeLessThanOrEqual(2)
	})

	it('stores the index in DATA_DIR and never writes into MUSIC_DIR', async () => {
		await writeFixture('a.wav', buildWav({ tags: { INAM: 'A' } }))
		await createIndexServer({ musicDir, dataDir })
		await waitForCatalog()

		// в DATA_DIR появился library.sqlite
		const dataEntries = await readdir(dataDir)
		expect(dataEntries).toContain('library.sqlite')

		// в MUSIC_DIR — только фикстуры, без служебных файлов
		const musicEntries = await readdir(musicDir, { recursive: true })
		expect(musicEntries.sort()).toEqual(['a.wav'])
	})

	it('reports enabled:false without MUSIC_DIR and keeps old endpoints intact', async () => {
		await createIndexServer({ musicDir: undefined, dataDir })
		const status = await getStatus()
		expect(status).toEqual({ enabled: false })

		const catalog = await getCatalog()
		expect([404, 503]).toContain(catalog.status)

		// старый files endpoint не сломан
		const files = await request(`${API_ROOT}/files`)
		expect(files.status).toBe(404)
		await expect(files.json()).resolves.toMatchObject({
			error: { code: 'SERVER_LIBRARY_DISABLED' },
		})
	})

	it('indexes 1000 generated WAV files and rescans without reparsing', {
		timeout: 300_000,
	}, async () => {
		const started = Date.now()
		for (let i = 0; i < 1000; i += 1) {
			const folder = `batch-${Math.floor(i / 100)}`
			await writeFixture(
				`${folder}/track-${i}.wav`,
				buildWav({ tags: { INAM: `Song ${i}` } }),
			)
		}
		const generatedMs = Date.now() - started

		await createIndexServer({ musicDir, dataDir })
		const scanStart = Date.now()
		const catalog = await waitForCatalog(240_000)
		const firstScanMs = Date.now() - scanStart

		expect(catalog.tracks).toHaveLength(1000)
		expect(parseTracker.calls).toBe(1000)

		parseTracker.reset()
		const rescanStart = Date.now()
		await postRescan()
		await waitForState('ready', 240_000)
		const rescanMs = Date.now() - rescanStart

		// главное требование §10: повторный scan не парсит unchanged
		expect(parseTracker.calls).toBe(0)

		// честные замеры в итог (без wall-clock assertions)
		console.info(
			`[perf] fixtures=${generatedMs}ms firstScan=${firstScanMs}ms rescan(no-parse)=${rescanMs}ms files=1000`,
		)
	})
})
