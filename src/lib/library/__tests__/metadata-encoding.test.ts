// Контракт: CONTRACTS.md §10 — fixLegacyTagEncoding (#26) чинит CP1251- и
// UTF-8-as-Latin-1 mojibake тегов и консервативно не трогает корректные
// Unicode/Latin-1 строки. Mojibake-входы строятся программно из байтов (#27).
import { describe, expect, it } from 'vitest'
import { fixLegacyTagEncoding } from '../metadata-encoding.ts'
import { cp1251AsLatin1, utf8AsLatin1 } from './tag-encoding-fixtures.ts'

describe('fixLegacyTagEncoding (#26 regression)', () => {
	describe('repairs legacy mojibake', () => {
		it.each([
			['plain cyrillic title', 'Группа крови'],
			['longer album title', 'Звезда по имени Солнце'],
			['Yo letters', 'Ёлки'],
			['typographic dash and number sign', 'В бою — №1'],
			['short artist name', 'Кино'],
			['mixed script title', 'Песня без слов (live)'],
		])('restores %s written in CP1251 but read as Latin-1', (_name, text) => {
			expect(fixLegacyTagEncoding(cp1251AsLatin1(text))).toBe(text)
		})

		it.each([
			['plain cyrillic title', 'Группа крови'],
			['short artist name', 'Кино'],
			['typographic dash', 'Песня — отличная'],
		])('restores %s written in UTF-8 but read as Latin-1', (_name, text) => {
			expect(fixLegacyTagEncoding(utf8AsLatin1(text))).toBe(text)
		})

		it('is idempotent: a repaired string is not repaired again', () => {
			const repaired = fixLegacyTagEncoding(cp1251AsLatin1('Группа крови'))
			expect(repaired).toBe('Группа крови')
			expect(fixLegacyTagEncoding(repaired)).toBe(repaired)
		})
	})

	describe('keeps legitimate strings untouched', () => {
		it.each([
			['single accented word', 'Café'],
			['latin1 title', 'Café del Mar'],
			['french artist', 'Éléonore'],
			['single non-ascii letter', 'Björk'],
			['umlauts', 'Mötley Crüe'],
			['tilde', 'Niña'],
			['pure ascii', 'Metallica'],
			['empty string', ''],
			['single char', 'a'],
		])('does not change %s', (_name, text) => {
			expect(fixLegacyTagEncoding(text)).toBe(text)
		})

		it.each([
			['already cyrillic', 'Группа крови'],
			['already cyrillic mojibake-resistant', 'Кино'],
		])('does not change %s', (_name, text) => {
			expect(fixLegacyTagEncoding(text)).toBe(text)
		})

		it.each([
			['chars outside Latin-1', 'Группа крови — live'],
			['outside Latin-1', '日本語のタイトル'],
			['emoji', '❤'],
		])('does not change a string with %s', (_name, text) => {
			expect(fixLegacyTagEncoding(text)).toBe(text)
		})

		it('does not repair latin1 text that would decode to mixed-script words', () => {
			// 'Éléonore': 2 non-ascii letters, but a CP1251 recode yields 'Йlйonore'
			// with a word mixing Cyrillic and Latin scripts — a false conversion.
			expect(fixLegacyTagEncoding('Éléonore')).toBe('Éléonore')
		})
	})
})
