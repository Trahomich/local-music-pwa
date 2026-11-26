// Контракт: CONTRACTS.md §10 — клиентский путь парсинга применяет fixLegacyTagEncoding
// (#26): legacy CP1251/UTF-8-as-Latin-1 теги чинятся, корректные Unicode/Latin-1 теги
// и fallback на имя файла не портятся. Паритет с серверным путём (#27).
import { describe, expect, it } from 'vitest'
import {
	buildLegacyMp3,
	buildUntaggedMp3,
	type LegacyMp3Tags,
} from '#lib/library/__tests__/tag-encoding-fixtures.ts'
import { CURRENT_METADATA_VERSION, UNKNOWN_ITEM } from '#lib/library/types.ts'
import { parseTrackMetadata } from '../parse-track-metadata.ts'

const parseFixture = async (name: string, bytes: Uint8Array<ArrayBuffer>) => {
	const file = new File([bytes], name, { type: 'audio/mpeg' })
	const parsed = await parseTrackMetadata(file)
	expect(parsed, `parseTrackMetadata must parse ${name}`).not.toBeNull()
	return (parsed as NonNullable<typeof parsed>).data
}

describe('parseTrackMetadata legacy tag encodings (#26 regression)', () => {
	it('repairs CP1251 tags mislabeled as ISO-8859-1', async () => {
		const tags: LegacyMp3Tags = {
			title: { text: 'Группа крови', encoding: 'cp1251' },
			artist: { text: 'Кино', encoding: 'cp1251' },
			album: { text: 'Звезда по имени Солнце', encoding: 'cp1251' },
			genre: { text: 'Рок', encoding: 'cp1251' },
		}
		const data = await parseFixture('cp1251.mp3', buildLegacyMp3(tags))

		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
		expect(data.album).toBe('Звезда по имени Солнце')
		expect(data.genre).toEqual(['Рок'])
		expect(data.metadataVersion).toBe(CURRENT_METADATA_VERSION)
	})

	it('repairs a mixed Cyrillic/Latin CP1251 title', async () => {
		const data = await parseFixture(
			'mixed.mp3',
			buildLegacyMp3({
				title: { text: 'Песня без слов (live)', encoding: 'cp1251' },
				artist: { text: 'Кино', encoding: 'cp1251' },
			}),
		)

		expect(data.name).toBe('Песня без слов (live)')
		expect(data.artists).toEqual(['Кино'])
	})

	it('repairs UTF-8 bytes mislabeled as ISO-8859-1', async () => {
		const data = await parseFixture(
			'utf8-as-latin1.mp3',
			buildLegacyMp3({
				title: { text: 'Группа крови', encoding: 'utf8-as-latin1' },
				artist: { text: 'Кино', encoding: 'utf8-as-latin1' },
			}),
		)

		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
	})

	it('keeps UTF-16 ID3v2.3 tags as parsed', async () => {
		const data = await parseFixture(
			'utf16.mp3',
			buildLegacyMp3({
				title: { text: 'Группа крови', encoding: 'utf16' },
				artist: { text: 'Кино', encoding: 'utf16' },
			}),
		)

		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
	})

	it('keeps UTF-8 ID3v2.4 tags as parsed', async () => {
		const data = await parseFixture(
			'utf8-v24.mp3',
			buildLegacyMp3({
				title: { text: 'Группа крови', encoding: 'utf8' },
				artist: { text: 'Кино', encoding: 'utf8' },
			}),
		)

		expect(data.name).toBe('Группа крови')
		expect(data.artists).toEqual(['Кино'])
	})

	it('keeps legitimate Latin-1 tags untouched', async () => {
		const data = await parseFixture(
			'latin1.mp3',
			buildLegacyMp3({
				title: { text: 'Café del Mar', encoding: 'latin1' },
				artist: { text: 'Éléonore', encoding: 'latin1' },
			}),
		)

		expect(data.name).toBe('Café del Mar')
		expect(data.artists).toEqual(['Éléonore'])
	})

	it('falls back to the proper-Unicode file name for tagless files', async () => {
		const data = await parseFixture('Кино — Группа крови.mp3', buildUntaggedMp3())

		expect(data.name).toBe('Кино — Группа крови.mp3')
		expect(data.artists).toEqual([UNKNOWN_ITEM])
	})
})
