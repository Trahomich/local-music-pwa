// Контракт: CONTRACTS.md §12 — канонические flat camelCase i18n-ключи офлайн-UI
// присутствуют и непустые в en/ru; progress несёт {done}/{total}, итог —
// {downloaded}/{current}/{skippedLocal}/{failed} (паритет всех локалей
// отдельно проверяет `pnpm run i18n-check`).
import { describe, expect, it } from 'vitest'
import enMessages from '../../../../messages/en.json'
import ruMessages from '../../../../messages/ru.json'

const messagesByLocale: Record<string, Record<string, string>> = {
	en: enMessages,
	ru: ruMessages,
}

const OFFLINE_KEYS = [
	'trackDownloadForOffline',
	'trackRemoveDownload',
	'trackDownloadUpdate',
	'trackDownloading',
	'trackDownloadFailed',
	'trackDownloadRemoved',
	'downloadPlaylist',
	'downloadPlaylistCancel',
	'downloadPlaylistProgress',
	'downloadPlaylistResult',
	'downloadPlaylistCancelled',
	'downloadQuotaError',
] as const

describe('offline i18n ключи (CONTRACTS.md §12)', () => {
	it.each(Object.entries(messagesByLocale))(
		'%s: все offline-ключи существуют и непустые',
		(_locale, messages) => {
			for (const key of OFFLINE_KEYS) {
				const value = messages[key] ?? ''
				expect(value.length, key).toBeGreaterThan(0)
			}
		},
	)

	it.each(Object.entries(messagesByLocale))(
		'%s: progress и итог несут обязательные плейсхолдеры',
		(_locale, messages) => {
			expect(messages.downloadPlaylistProgress).toContain('{done}')
			expect(messages.downloadPlaylistProgress).toContain('{total}')
			expect(messages.downloadPlaylistResult).toContain('{downloaded}')
			expect(messages.downloadPlaylistResult).toContain('{current}')
			expect(messages.downloadPlaylistResult).toContain('{skippedLocal}')
			expect(messages.downloadPlaylistResult).toContain('{failed}')
		},
	)

	it('ru-строки отличаются от en (перевод, не копия)', () => {
		for (const key of OFFLINE_KEYS) {
			expect(ruMessages[key], key).not.toBe(enMessages[key])
		}
	})
})
