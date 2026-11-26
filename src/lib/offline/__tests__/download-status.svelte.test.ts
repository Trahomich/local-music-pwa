/**
 * Regression (#35): холодный вызов getBatchProgress() внутри $derived во время
 * рендера (PlaylistDownloadControls на detail-странице плейлиста) не должен
 * кидать state_unsafe_mutation: ensureStarted() синхронно мутировал $state
 * batchInfo, что запрещено в derived/render-контексте Svelte 5.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { getBatchProgress } from '../download-status.svelte.ts'

describe('download-status cold start (regression #35)', () => {
	it('getBatchProgress() inside a cold $derived does not throw state_unsafe_mutation', () => {
		let read: (() => unknown) | undefined
		const cleanup = $effect.root(() => {
			// Первый вызов в сессии — как при рендере detail-страницы плейлиста,
			// когда никакое меню трека ещё не открывалось.
			const batch = $derived.by(() => getBatchProgress())
			read = () => batch
		})

		expect(() => read?.()).not.toThrow()
		cleanup()
	})
})
