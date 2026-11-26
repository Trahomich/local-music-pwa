// Контракт: CONTRACTS.md §12 — user-state sync без сети: пока
// navigator.onLine === false, тики polling пропускаются молча (ни одного
// запроса, ни ложного success, ни console.error); событие `online` немедленно
// возобновляет polling; stopUserStateSync снимает и online-listener.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserStateSnapshot } from '#lib/auth/api.ts'
import { startUserStateSync, stopUserStateSync } from '#lib/user-state/sync.ts'

const mocks = vi.hoisted(() => ({
	userId: '7' as string | null,
	fetchSnapshot: vi.fn(),
	applySnapshot: vi.fn(),
}))

vi.mock('#lib/auth/client.ts', () => ({
	getCurrentUserId: () => mocks.userId,
}))

vi.mock('#lib/user-state/client.ts', () => ({
	fetchUserStateSnapshot: mocks.fetchSnapshot,
	UserStateRequestError: class UserStateRequestError extends Error {
		code: string

		constructor(code: string, message: string) {
			super(message)
			this.code = code
		}
	},
}))

vi.mock('#lib/user-state/snapshot.ts', () => ({
	applyUserStateSnapshot: mocks.applySnapshot,
}))

const snapshot: UserStateSnapshot = {
	version: 1,
	revision: 1,
	playlists: [],
	playlistEntries: [],
	history: [],
}

const setOnLine = (value: boolean): void => {
	Object.defineProperty(window.navigator, 'onLine', {
		configurable: true,
		writable: true,
		value,
	})
}

beforeEach(() => {
	mocks.userId = '7'
	mocks.fetchSnapshot.mockReset().mockResolvedValue(snapshot)
	mocks.applySnapshot.mockReset().mockResolvedValue(undefined)
	setOnLine(true)
})

afterEach(() => {
	stopUserStateSync()
	// Возвращаем prototype getter navigator.onLine вместо нашего own property.
	delete (window.navigator as unknown as Record<string, unknown>).onLine
	vi.restoreAllMocks()
})

describe('user-state sync offline (§12)', () => {
	it('start при onLine=false: ни одного запроса и ни одной ошибки', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		setOnLine(false)

		startUserStateSync()

		expect(mocks.fetchSnapshot).not.toHaveBeenCalled()
		expect(mocks.applySnapshot).not.toHaveBeenCalled()
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it('focus/visibilitychange при onLine=false не порождают запросов', () => {
		setOnLine(false)
		startUserStateSync()

		window.dispatchEvent(new Event('focus'))
		document.dispatchEvent(new Event('visibilitychange'))

		expect(mocks.fetchSnapshot).not.toHaveBeenCalled()
	})

	it('событие online немедленно возобновляет polling и применяет snapshot', async () => {
		setOnLine(false)
		startUserStateSync()
		expect(mocks.fetchSnapshot).not.toHaveBeenCalled()

		setOnLine(true)
		window.dispatchEvent(new Event('online'))
		// Даём микротаскам завершиться (poll — async).
		await vi.waitFor(() => {
			expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(1)
		})

		expect(mocks.applySnapshot).toHaveBeenCalledTimes(1)
		expect(mocks.applySnapshot).toHaveBeenCalledWith(snapshot)
	})

	it('stopUserStateSync снимает online-listener: после stop событие online не вызывает fetch', () => {
		setOnLine(false)
		startUserStateSync()
		stopUserStateSync()

		setOnLine(true)
		window.dispatchEvent(new Event('online'))

		expect(mocks.fetchSnapshot).not.toHaveBeenCalled()
	})

	it('onLine=true: start делает initial fetch (offline-пропуск не задерживает обычный режим)', async () => {
		startUserStateSync()

		await vi.waitFor(() => {
			expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(1)
		})
		expect(mocks.applySnapshot).toHaveBeenCalledWith(snapshot)
	})
})
