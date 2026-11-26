// Контракт: CONTRACTS.md §13 — startup-синхронизация серверной библиотеки:
// один раз за page lifetime после auth/bootstrap в (app)/+layout.svelte;
// offline browser и local-only профиль сетевой scan не запускают; 401/503/
// NETWORK_ERROR не стирают cached tracks и показывают локализованный snackbar;
// ровно один отложенный retry по событию `online`, без retry-цикла.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '#lib/db/database.ts'
import { clearDatabaseStores } from '#lib/helpers/test-helpers.ts'
import { SERVER_DIRECTORY_ID } from '#lib/library/types.ts'
import { resetServerLibraryStartupSyncForTests, startServerLibraryStartupSync } from '../startup.ts'

const mocks = vi.hoisted(() => ({
	userId: '7' as string | null,
	bootstrapAuth: vi.fn(),
	getCurrentUserId: vi.fn(),
	fetchStatus: vi.fn(),
	importServerDirectory: vi.fn(),
	rescanServerDirectory: vi.fn(),
	unexpectedError: vi.fn(),
}))

vi.mock('#lib/auth/client.ts', () => ({
	bootstrapAuth: mocks.bootstrapAuth,
	getCurrentUserId: mocks.getCurrentUserId,
	registerAuthChangeHandler: () => () => {},
}))

vi.mock('#lib/library/scan-actions/directories.ts', () => ({
	importServerDirectory: mocks.importServerDirectory,
	rescanServerDirectory: mocks.rescanServerDirectory,
}))

vi.mock('#lib/server-library/client.ts', () => ({
	fetchServerLibraryStatus: mocks.fetchStatus,
	ServerLibraryRequestError: class ServerLibraryRequestError extends Error {
		readonly code: string
		readonly httpStatus: number

		constructor(code: string, httpStatus: number, message: string) {
			super(message)
			this.name = 'ServerLibraryRequestError'
			this.code = code
			this.httpStatus = httpStatus
		}
	},
}))

vi.mock('#lib/components/snackbar/snackbar.ts', () => ({
	snackbar: Object.assign(vi.fn(), {
		unexpectedError: mocks.unexpectedError,
		dismiss: vi.fn(),
	}),
}))

import { ServerLibraryRequestError } from '#lib/server-library/client.ts'

const setOnLine = (value: boolean): void => {
	Object.defineProperty(window.navigator, 'onLine', {
		configurable: true,
		writable: true,
		value,
	})
}

const seedServerDirectory = async (): Promise<void> => {
	const db = await getDatabase()
	await db.put('directories', { id: SERVER_DIRECTORY_ID, kind: 'server' })
}

beforeEach(() => {
	resetServerLibraryStartupSyncForTests()
	mocks.userId = '7'
	mocks.bootstrapAuth.mockReset().mockResolvedValue({ status: 'authenticated' })
	mocks.getCurrentUserId.mockReset().mockImplementation(() => mocks.userId)
	mocks.fetchStatus.mockReset().mockResolvedValue({ enabled: true })
	mocks.importServerDirectory.mockReset().mockResolvedValue(undefined)
	mocks.rescanServerDirectory.mockReset().mockResolvedValue(undefined)
	mocks.unexpectedError.mockReset()
	setOnLine(true)
})

afterEach(async () => {
	resetServerLibraryStartupSyncForTests()
	await clearDatabaseStores()
	delete (window.navigator as unknown as Record<string, unknown>).onLine
	vi.restoreAllMocks()
})

describe('server library startup sync (§13)', () => {
	it('источника ещё нет → importServerDirectory(), rescan не вызывается', async () => {
		startServerLibraryStartupSync()

		await vi.waitFor(() => {
			expect(mocks.importServerDirectory).toHaveBeenCalledTimes(1)
		})
		expect(mocks.rescanServerDirectory).not.toHaveBeenCalled()
		expect(mocks.unexpectedError).not.toHaveBeenCalled()
	})

	it('источник уже есть → rescanServerDirectory(), import не вызывается', async () => {
		await seedServerDirectory()

		startServerLibraryStartupSync()

		await vi.waitFor(() => {
			expect(mocks.rescanServerDirectory).toHaveBeenCalledTimes(1)
		})
		expect(mocks.importServerDirectory).not.toHaveBeenCalled()
	})

	it('status.enabled !== true → никаких действий и ни одной ошибки', async () => {
		mocks.fetchStatus.mockResolvedValue({ enabled: false })

		startServerLibraryStartupSync()

		await vi.waitFor(() => {
			expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)
		})
		expect(mocks.importServerDirectory).not.toHaveBeenCalled()
		expect(mocks.rescanServerDirectory).not.toHaveBeenCalled()
		expect(mocks.unexpectedError).not.toHaveBeenCalled()
	})

	it('local-only/static hosting (userId === null) → сетевого scan нет, без ошибок', async () => {
		mocks.userId = null

		startServerLibraryStartupSync()

		await vi.waitFor(() => {
			expect(mocks.bootstrapAuth).toHaveBeenCalledTimes(1)
		})
		expect(mocks.fetchStatus).not.toHaveBeenCalled()
		expect(mocks.importServerDirectory).not.toHaveBeenCalled()
		expect(mocks.rescanServerDirectory).not.toHaveBeenCalled()
		expect(mocks.unexpectedError).not.toHaveBeenCalled()
	})

	it('offline при старте: ни одного запроса; событие online делает ровно один retry', async () => {
		setOnLine(false)

		startServerLibraryStartupSync()
		await vi.waitFor(() => {
			expect(mocks.bootstrapAuth).toHaveBeenCalledTimes(1)
		})
		expect(mocks.fetchStatus).not.toHaveBeenCalled()
		expect(mocks.unexpectedError).not.toHaveBeenCalled()

		setOnLine(true)
		window.dispatchEvent(new Event('online'))

		await vi.waitFor(() => {
			expect(mocks.importServerDirectory).toHaveBeenCalledTimes(1)
		})
		expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)
	})

	it('NETWORK_ERROR: локализованная ошибка + один retry; повторный online не перезапускает', async () => {
		mocks.fetchStatus.mockRejectedValue(
			new ServerLibraryRequestError('NETWORK_ERROR', 0, 'down'),
		)

		startServerLibraryStartupSync()

		await vi.waitFor(() => {
			expect(mocks.unexpectedError).toHaveBeenCalledTimes(1)
		})
		expect(mocks.importServerDirectory).not.toHaveBeenCalled()
		expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)

		// Первый retry по online: опять NETWORK_ERROR → вторая ошибка, но
		// retry-цикл не продлевается (guard onlineRetryUsed).
		setOnLine(true)
		window.dispatchEvent(new Event('online'))
		await vi.waitFor(() => {
			expect(mocks.fetchStatus).toHaveBeenCalledTimes(2)
		})
		await vi.waitFor(() => {
			expect(mocks.unexpectedError).toHaveBeenCalledTimes(2)
		})

		window.dispatchEvent(new Event('online'))
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(mocks.fetchStatus).toHaveBeenCalledTimes(2)
		expect(mocks.unexpectedError).toHaveBeenCalledTimes(2)
	})

	it('HTTP 503: локализованная ошибка, retry не планируется', async () => {
		mocks.fetchStatus.mockRejectedValue(
			new ServerLibraryRequestError('SCAN_FAILED', 503, 'unavailable'),
		)

		startServerLibraryStartupSync()

		await vi.waitFor(() => {
			expect(mocks.unexpectedError).toHaveBeenCalledTimes(1)
		})

		window.dispatchEvent(new Event('online'))
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)
		expect(mocks.importServerDirectory).not.toHaveBeenCalled()
	})

	it('повторный start за page lifetime: status запрашивается ровно один раз', async () => {
		startServerLibraryStartupSync()
		startServerLibraryStartupSync()

		await vi.waitFor(() => {
			expect(mocks.importServerDirectory).toHaveBeenCalledTimes(1)
		})
		expect(mocks.fetchStatus).toHaveBeenCalledTimes(1)
	})
})
