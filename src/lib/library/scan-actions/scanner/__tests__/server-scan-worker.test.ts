// Контракт: CONTRACTS.md §10 — scanner worker: 401 → finished с authRequired без записей в БД,
// прочие ошибки → error без authRequired; прогресс server-scan при ожидании индекса;
// ни один server scan не обращается к audio file endpoint. Независимые тесты (#22).
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '#lib/db/database.ts'
import { clearDatabaseStores } from '#lib/helpers/test-helpers.ts'
import { SERVER_DIRECTORY_ID } from '#lib/library/types.ts'
import {
	installServerLibraryMock,
	serverCatalogTrack,
	serverFileDescriptor,
} from '#lib/server-library/__tests__/server-library-mock.ts'

interface FakeWorkerSelf {
	addEventListener: ReturnType<typeof vi.fn>
	postMessage: ReturnType<typeof vi.fn>
	setTimeout: typeof setTimeout
	clearTimeout: typeof clearTimeout
}

let fakeSelf: FakeWorkerSelf
let handleMessage: (event: MessageEvent) => Promise<void>
let mock: ReturnType<typeof installServerLibraryMock>

const scanMessageCalls = (): Array<{
	finished: boolean
	count: {
		newlyImported: number
		current: number
		total: number
		error?: boolean
		authRequired?: boolean
		phase?: 'server-scan'
	}
}> => fakeSelf.postMessage.mock.calls.map((call) => call[0])

const runServerScan = async (
	action: 'server-directory-add' | 'server-directory-rescan',
): Promise<void> => {
	await handleMessage({ data: { action, dirId: SERVER_DIRECTORY_ID } } as MessageEvent)
	// The tracker coalesces progress posts on a 200ms timer; let it flush.
	await new Promise((resolve) => setTimeout(resolve, 250))
}

describe('scanner worker messages', () => {
	beforeEach(async () => {
		await clearDatabaseStores()

		fakeSelf = {
			addEventListener: vi.fn(),
			postMessage: vi.fn(),
			setTimeout: globalThis.setTimeout.bind(globalThis),
			clearTimeout: globalThis.clearTimeout.bind(globalThis),
		}
		vi.stubGlobal('self', fakeSelf)

		vi.resetModules()
		await import('#lib/library/scan-actions/scanner/worker.ts')

		const registration = fakeSelf.addEventListener.mock.calls.find(
			([eventName]) => eventName === 'message',
		)
		if (!registration) {
			throw new Error('scanner worker did not register a message listener')
		}
		handleMessage = registration[1] as (event: MessageEvent) => Promise<void>

		// Silence the worker's error reporting; assertions cover the posted message.
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('reports a 401 as a finished message with authRequired and writes nothing', async () => {
		mock = installServerLibraryMock({ catalogStatuses: [401] })

		await runServerScan('server-directory-add')

		expect(scanMessageCalls()).toEqual([
			{
				finished: true,
				count: { newlyImported: 0, current: 0, total: 0, error: true, authRequired: true },
			},
		])
		const db = await getDatabase()
		expect(await db.getAll('tracks')).toHaveLength(0)
	})

	it('reports a rescan 503 as an error without authRequired and keeps previous tracks', async () => {
		mock = installServerLibraryMock({
			catalogTracks: [serverCatalogTrack(serverFileDescriptor('Artist/a.mp3'))],
		})
		await runServerScan('server-directory-add')
		const importedBefore = (await (await getDatabase()).getAll('tracks')).map((t) => t.id)
		expect(importedBefore).toHaveLength(1)

		fakeSelf.postMessage.mockClear()
		mock.state.rescanStatus = 503

		await runServerScan('server-directory-rescan')

		expect(scanMessageCalls()).toEqual([
			{
				finished: true,
				count: { newlyImported: 0, current: 0, total: 0, error: true, authRequired: false },
			},
		])
		// The POST failed before the catalog: no status polling, no DB writes.
		expect(
			mock.requests.filter((request) => request.pathname === '/api/server-library/status'),
		).toHaveLength(0)
		const importedAfter = (await (await getDatabase()).getAll('tracks')).map((t) => t.id)
		expect(importedAfter).toEqual(importedBefore)
	})

	it('posts import progress and a finished message without error flags on success', async () => {
		mock = installServerLibraryMock({
			catalogTracks: [
				serverCatalogTrack(serverFileDescriptor('Artist/a.mp3')),
				serverCatalogTrack(serverFileDescriptor('Artist/b.mp3')),
			],
		})

		await runServerScan('server-directory-add')

		const messages = scanMessageCalls()
		const last = messages.at(-1)
		expect(last).toEqual({ finished: true, count: { newlyImported: 2, current: 2, total: 2 } })

		const progressMessages = messages.filter((message) => !message.finished)
		expect(progressMessages.length).toBeGreaterThan(0)
		for (const message of progressMessages) {
			expect(message.count.total).toBe(2)
			expect(message.count.error).toBeUndefined()
			expect(message.count.authRequired).toBeUndefined()
		}

		// CONTRACTS.md §10: audio file and file-list endpoints must never be hit.
		for (const request of mock.requests) {
			expect(request.pathname).not.toBe('/api/server-library/file')
			expect(request.pathname).not.toBe('/api/server-library/files')
		}
	})

	it('forwards server scan progress with the server-scan phase during rescan', async () => {
		mock = installServerLibraryMock({
			catalogTracks: [serverCatalogTrack(serverFileDescriptor('Artist/a.mp3'))],
		})
		await runServerScan('server-directory-add')

		fakeSelf.postMessage.mockClear()
		mock.state.scanStatuses = [
			{ enabled: true, state: 'scanning', current: 1, total: 3 },
			{ enabled: true, state: 'ready', current: 3, total: 3 },
		]

		await runServerScan('server-directory-rescan')

		const messages = scanMessageCalls()
		const serverProgress = messages.filter((message) => message.count.phase === 'server-scan')
		expect(serverProgress.length).toBeGreaterThan(0)
		expect(serverProgress[0]?.finished).toBe(false)
		expect(serverProgress[0]?.count).toMatchObject({ current: 1, total: 3 })

		// The rescan asks the server to refresh its index before polling the status.
		const methods = mock.requests.map((request) => `${request.method} ${request.pathname}`)
		const rescanIndex = methods.indexOf('POST /api/server-library/rescan')
		const statusIndex = methods.indexOf('GET /api/server-library/status')
		expect(rescanIndex).toBeGreaterThanOrEqual(0)
		expect(statusIndex).toBeGreaterThan(rescanIndex)

		const last = messages.at(-1)
		expect(last?.finished).toBe(true)
		expect(last?.count.error).toBeUndefined()
	})
})
