// Контракт: CONTRACTS.md §12 — для album download добавлен канонический flat
// camelCase ключ `downloadAlbum` (кнопка альбома) во всех локалях; общие
// progress/result ключи playlist переиспользуются album-путём (один UI
// control), поэтому их плейсхолдеры обязаны остаться нетронутыми.
// Независимая проверка #40; паритет всех локалей отдельно гарантирует
// `pnpm run i18n-check`.
import { describe, expect, it } from 'vitest'
import enMessages from '../../../../messages/en.json'
import ruMessages from '../../../../messages/ru.json'

const messagesByLocale: Record<string, Record<string, string>> = {
	en: enMessages,
	ru: ruMessages,
}

// Новый ключ альбома + переиспользуемые album/playlist ключи batch UI.
const FLAT_CAMEL_CASE_KEY = /^[a-z][a-zA-Z0-9]*$/
const ALBUM_BATCH_KEYS = [
	'downloadAlbum',
	'downloadPlaylistCancel',
	'downloadPlaylistProgress',
	'downloadPlaylistResult',
	'downloadPlaylistCancelled',
	'downloadQuotaError',
] as const

describe('album download i18n ключи (CONTRACTS.md §12, #40)', () => {
	it.each(Object.entries(messagesByLocale))(
		'%s: downloadAlbum и переиспользуемые batch-ключи существуют и непустые',
		(_locale, messages) => {
			for (const key of ALBUM_BATCH_KEYS) {
				const value = messages[key] ?? ''
				expect(value.length, key).toBeGreaterThan(0)
			}
		},
	)

	it.each(Object.entries(messagesByLocale))(
		'%s: progress/result плейсхолдеры не сломаны album-путём',
		(_locale, messages) => {
			expect(messages.downloadPlaylistProgress).toContain('{done}')
			expect(messages.downloadPlaylistProgress).toContain('{total}')
			expect(messages.downloadPlaylistResult).toContain('{downloaded}')
			expect(messages.downloadPlaylistResult).toContain('{current}')
			expect(messages.downloadPlaylistResult).toContain('{skippedLocal}')
			expect(messages.downloadPlaylistResult).toContain('{failed}')
		},
	)

	it('ru downloadAlbum — перевод, а не копия en', () => {
		expect(ruMessages.downloadAlbum).not.toBe(enMessages.downloadAlbum)
	})

	it('ключи flat camelCase без точек (generated exports)', () => {
		for (const key of ALBUM_BATCH_KEYS) {
			expect(key).toMatch(FLAT_CAMEL_CASE_KEY)
		}
	})
})
