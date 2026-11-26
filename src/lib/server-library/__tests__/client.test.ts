// Контракт: CONTRACTS.md §4, §10 — клиент server library: коды ошибок по HTTP-статусам,
// artwork строго по content hash (malformed hash без сети), polling статуса скана
// (ready/error/disabled). Независимая проверка поверх server-library-mock (автор — #21/#16).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	fetchServerLibraryArtwork,
	fetchServerLibraryCatalog,
	requestServerLibraryRescan,
	ServerLibraryRequestError,
	waitForServerLibraryScan,
} from '#lib/server-library/client.ts'
import {
	installServerLibraryMock,
	SERVER_ARTWORK_HASH,
	serverCatalogTrack,
	serverFileDescriptor,
} from './server-library-mock.ts'

describe('server library client', () => {
	let mock: ReturnType<typeof installServerLibraryMock>

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('resolves the catalog with tracks on 200', async () => {
		mock = installServerLibraryMock({
			catalogTracks: [serverCatalogTrack(serverFileDescriptor('Artist/a.mp3'))],
		})

		const catalog = await fetchServerLibraryCatalog()

		expect(catalog.tracks).toHaveLength(1)
		expect(catalog.tracks[0]?.descriptor.path).toBe('Artist/a.mp3')
		expect(
			mock.requests.some(
				(request) =>
					request.method === 'GET' && request.pathname === '/api/server-library/catalog',
			),
		).toBe(true)
	})

	it.each([
		[401, 'AUTH_REQUIRED'],
		[409, 'SCAN_IN_PROGRESS'],
		[503, 'DIRECTORY_UNAVAILABLE'],
		[500, 'INTERNAL_ERROR'],
	] as const)('rejects catalog %i with code %s', async (status, code) => {
		mock = installServerLibraryMock({ catalogStatuses: [status] })

		const failure = await fetchServerLibraryCatalog().then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe(code)
		expect((failure as ServerLibraryRequestError).httpStatus).toBe(status)
	})

	it('rejects catalog with NETWORK_ERROR when the request itself fails', async () => {
		mock = installServerLibraryMock({ networkError: true })

		const failure = await fetchServerLibraryCatalog().then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe('NETWORK_ERROR')
	})

	it('rejects a malformed artwork hash without any network request', async () => {
		mock = installServerLibraryMock()

		const failure = await fetchServerLibraryArtwork('not-a-64-hex-hash').then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe('ARTWORK_NOT_FOUND')
		expect(mock.requests).toHaveLength(0)
	})

	it('downloads artwork bytes only from the content-hash endpoint', async () => {
		mock = installServerLibraryMock({
			artworkBodies: { [SERVER_ARTWORK_HASH]: 'fake-artwork-bytes' },
		})

		const blob = await fetchServerLibraryArtwork(SERVER_ARTWORK_HASH)

		expect(await blob.text()).toBe('fake-artwork-bytes')
		expect(mock.requests).toEqual([
			{
				method: 'GET',
				pathname: `/api/server-library/artwork/${SERVER_ARTWORK_HASH}`,
				queryPath: null,
			},
		])
	})

	it('rejects an unknown artwork hash with ARTWORK_NOT_FOUND', async () => {
		mock = installServerLibraryMock()

		const failure = await fetchServerLibraryArtwork(SERVER_ARTWORK_HASH).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe('ARTWORK_NOT_FOUND')
	})

	it('resolves rescan on 202 without a body', async () => {
		mock = installServerLibraryMock({ rescanStatus: 202 })

		await expect(requestServerLibraryRescan()).resolves.toBeUndefined()
		expect(mock.requests).toEqual([
			{ method: 'POST', pathname: '/api/server-library/rescan', queryPath: null },
		])
	})

	it('rejects rescan 503 with DIRECTORY_UNAVAILABLE', async () => {
		mock = installServerLibraryMock({ rescanStatus: 503 })

		const failure = await requestServerLibraryRescan().then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe('DIRECTORY_UNAVAILABLE')
	})

	it('polls scanning statuses, reports progress and resolves on ready', async () => {
		mock = installServerLibraryMock({
			scanStatuses: [
				{ enabled: true, state: 'scanning', current: 1, total: 3 },
				{ enabled: true, state: 'scanning', current: 2, total: 3 },
				{ enabled: true, state: 'ready', current: 3, total: 3 },
			],
		})
		const progress = vi.fn()

		const status = await waitForServerLibraryScan({ onProgress: progress })

		expect(status.state).toBe('ready')
		expect(progress).toHaveBeenCalledTimes(2)
		expect(progress.mock.calls[0]?.[0]).toMatchObject({
			state: 'scanning',
			current: 1,
			total: 3,
		})
		expect(progress.mock.calls[1]?.[0]).toMatchObject({
			state: 'scanning',
			current: 2,
			total: 3,
		})
	})

	it('rejects with SCAN_FAILED carrying the server error message on error state', async () => {
		mock = installServerLibraryMock({
			scanStatuses: [{ enabled: true, state: 'error', error: 'read failed' }],
		})

		const failure = await waitForServerLibraryScan().then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe('SCAN_FAILED')
		expect((failure as Error).message).toContain('read failed')
	})

	it('rejects with SERVER_LIBRARY_DISABLED when the library is off', async () => {
		mock = installServerLibraryMock({ scanStatuses: [{ enabled: false }] })

		const failure = await waitForServerLibraryScan().then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(ServerLibraryRequestError)
		expect((failure as ServerLibraryRequestError).code).toBe('SERVER_LIBRARY_DISABLED')
	})
})
