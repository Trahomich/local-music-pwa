// Контракт: CONTRACTS.md §10 — UI-слой scan-tracks: server-scan прогресс с серверными
// current/total, отдельное auth-сообщение при 401 (не «библиотека пуста»), локальный
// прогресс и итоговые сообщения остаются прежними. Независимые тесты (#22).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as m from 'i18n:messages'
import { snackbar } from '#lib/components/snackbar/snackbar.ts'
import { SERVER_DIRECTORY_ID } from '#lib/library/types.ts'
import { scanTracks } from '../scan-tracks.ts'
import {
	startTrackScannerWorker,
	type TracksScanOptions,
	type TracksScanResult,
} from '../scanner/start.ts'

vi.mock('../scanner/start.ts', () => ({
	startTrackScannerWorker: vi.fn(),
}))

vi.mock('#lib/components/snackbar/snackbar.ts', () => ({
	snackbar: Object.assign(vi.fn(), {
		unexpectedError: vi.fn(),
	}),
}))

const mockedWorker = vi.mocked(startTrackScannerWorker)
const mockedSnackbar = vi.mocked(snackbar)

const SCAN_OPTIONS: TracksScanOptions = {
	action: 'server-directory-rescan',
	dirId: SERVER_DIRECTORY_ID,
}

/** Runs scanTracks with a worker that reports the given progress, then resolves with the result. */
const runScan = async (progress: TracksScanResult[], result: TracksScanResult): Promise<void> => {
	mockedWorker.mockImplementation((_options, onProgress) => {
		for (const item of progress) {
			onProgress(item)
		}
		return Promise.resolve(result)
	})

	await scanTracks(SCAN_OPTIONS)
}

const snackbarCalls = (): Array<{ id?: string; message: string; duration?: number | false }> =>
	mockedSnackbar.mock.calls.map((call) => call[0] as never)

describe('scanTracks UI messages', () => {
	beforeEach(() => {
		mockedWorker.mockReset()
		mockedSnackbar.mockClear()
	})

	it('always starts with the preparing message', async () => {
		await runScan([], { newlyImported: 0, current: 0, total: 0 })

		expect(snackbarCalls()[0]).toMatchObject({
			id: 'scan-tracks',
			message: m.settingsPreparingForScan(),
			duration: false,
		})
	})

	it('routes server-scan phase progress to the server progress message', async () => {
		await runScan([{ newlyImported: 0, current: 7, total: 42, phase: 'server-scan' }], {
			newlyImported: 3,
			current: 3,
			total: 3,
		})

		expect(snackbarCalls()).toContainEqual({
			id: 'scan-tracks',
			message: m.settingsServerScanInProgress({ current: 7, total: 42 }),
			controls: false,
			duration: false,
		})
	})

	it('keeps local scan progress on the local progress message', async () => {
		await runScan([{ newlyImported: 1, current: 2, total: 5 }], {
			newlyImported: 1,
			current: 5,
			total: 5,
		})

		expect(snackbarCalls()).toContainEqual({
			id: 'scan-tracks',
			message: m.settingsScanInProgress({ current: 2, total: 5 }),
			controls: false,
			duration: false,
		})
	})

	it('shows the auth-required message instead of a generic failure on 401', async () => {
		await runScan([], {
			newlyImported: 0,
			current: 0,
			total: 0,
			error: true,
			authRequired: true,
		})

		expect(snackbarCalls().at(-1)).toMatchObject({
			id: 'scan-tracks',
			message: m.settingsScanAuthRequired(),
			duration: 8000,
		})
		expect(snackbarCalls().at(-1)?.message).not.toBe(m.settingsScanFailed())
	})

	it('shows the generic failure message when the scan fails without authRequired', async () => {
		await runScan([], { newlyImported: 0, current: 0, total: 0, error: true })

		expect(snackbarCalls().at(-1)).toMatchObject({
			id: 'scan-tracks',
			message: m.settingsScanFailed(),
			duration: 8000,
		})
	})

	it('never reports an error as an empty library: no «no new tracks» after a failure', async () => {
		await runScan([], {
			newlyImported: 0,
			current: 0,
			total: 0,
			error: true,
			authRequired: true,
		})

		const messages = snackbarCalls().map((call) => call.message)
		expect(messages).not.toContain(m.settingsScanNoNewTracks())
	})

	it('reports an up-to-date library when nothing was imported', async () => {
		await runScan([], { newlyImported: 0, current: 2, total: 2 })

		expect(snackbarCalls().at(-1)).toMatchObject({
			id: 'scan-tracks',
			message: m.settingsScanNoNewTracks(),
			duration: 2000,
		})
	})

	it('reports the imported count after a successful scan', async () => {
		await runScan([], { newlyImported: 4, current: 4, total: 4 })

		expect(snackbarCalls().at(-1)).toMatchObject({
			id: 'scan-tracks',
			message: m.settingsScanNewOrUpdatedTracks({ newTracks: 4 }),
			duration: 8000,
		})
	})
})
