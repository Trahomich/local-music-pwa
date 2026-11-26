// Fixes text tags that were written in a legacy single-byte encoding (Windows-1251
// or UTF-8 bytes) but flagged as ISO-8859-1, which `music-metadata` then decodes as
// Latin-1 — turning e.g. "Группа крови" into "Ãðóïïà êðîâè". Applies to both the
// server (`server/library/scanner.ts`) and the browser scanner
// (`src/lib/library/scan-actions/scanner/steps/parse-track-metadata.ts`).

const CYRILLIC_RE = /[\u0400-\u04ff]/
const LATIN_LETTER_RE = /[a-z\u00c0-\u00ff]/i
const LETTER_RUN_RE = /[\p{L}]+/gu
/** A single stray non-ASCII character (e.g. "Björk") is not enough evidence to convert. */
const MIN_CYRILLIC_LETTERS = 2

/** True when any char lies outside U+0000–U+00FF, i.e. the string is already proper Unicode. */
const hasCharOutsideLatin1 = (text: string): boolean => {
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) > 0xff) {
			return true
		}
	}
	return false
}

const latin1ToBytes = (text: string): Uint8Array => {
	const bytes = new Uint8Array(text.length)
	for (let index = 0; index < text.length; index += 1) {
		bytes[index] = text.charCodeAt(index)
	}
	return bytes
}

const countCyrillicLetters = (text: string): number => {
	let count = 0
	for (const char of text) {
		if (CYRILLIC_RE.test(char)) {
			count += 1
		}
	}
	return count
}

// Real mojibake turns whole words Cyrillic; a false conversion ("Café" -> "Cafй")
// leaves words mixing Cyrillic and Latin letters. Requiring single-script words keeps
// legitimate Latin-1 titles intact.
const hasMixedScriptWord = (text: string): boolean => {
	for (const match of text.matchAll(LETTER_RUN_RE)) {
		let hasCyrillic = false
		let hasLatin = false
		for (const char of match[0]) {
			if (CYRILLIC_RE.test(char)) {
				hasCyrillic = true
			} else if (LATIN_LETTER_RE.test(char)) {
				hasLatin = true
			}
		}
		if (hasCyrillic && hasLatin) {
			return true
		}
	}
	return false
}

const tryDecode = (bytes: Uint8Array, encoding: string): string | null => {
	try {
		return new TextDecoder(encoding, { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}

const isPlausibleCyrillic = (text: string | null): text is string => {
	if (text === null) {
		return false
	}
	// U+0098 is undefined in Windows-1251; U+FFFD marks a lossy decode. Both signal
	// we are looking at bytes that are neither clean CP1251 nor clean UTF-8.
	if (text.includes('�') || text.includes('\u0098')) {
		return false
	}
	if (countCyrillicLetters(text) < MIN_CYRILLIC_LETTERS) {
		return false
	}
	return !hasMixedScriptWord(text)
}

/**
 * Repairs a tag string decoded as Latin-1 while its bytes were Windows-1251 or UTF-8.
 *
 * Intentionally conservative: returns the input untouched unless every character fits
 * Latin-1, there is no Cyrillic in it already, and a candidate recoding yields clean
 * Cyrillic text with no word mixing Cyrillic and Latin scripts. File names and JSON
 * transport are proper Unicode and must not be passed here.
 */
/** @public */
export const fixLegacyTagEncoding = (text: string): string => {
	if (hasCharOutsideLatin1(text) || CYRILLIC_RE.test(text)) {
		return text
	}

	let nonAsciiCount = 0
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) >= 0x80) {
			nonAsciiCount += 1
		}
	}
	if (nonAsciiCount < MIN_CYRILLIC_LETTERS) {
		return text
	}

	const bytes = latin1ToBytes(text)
	// A strict UTF-8 decode that yields clean Cyrillic is strong evidence: genuine
	// Windows-1251 Russian text almost never forms valid UTF-8, so the UTF-8 candidate
	// wins whenever it is viable (handles taggers writing UTF-8 bytes under Latin-1).
	const utf8 = tryDecode(bytes, 'utf-8')
	if (isPlausibleCyrillic(utf8)) {
		return utf8
	}
	const windows1251 = tryDecode(bytes, 'windows-1251')
	if (isPlausibleCyrillic(windows1251)) {
		return windows1251
	}
	return text
}
