/**
 * Генераторы MP3-фикстур с legacy ID3-кодировками тегов для regression-тестов #27
 * (исправление #26, CONTRACTS.md §10). Все байты строятся программно: mojibake-строки
 * нельзя вставлять литералами — control-символы U+0080–U+009F теряются при копировании.
 * Используется серверным (`server/__tests__/metadata-encoding.test.ts`) и клиентским
 * (`parse-track-metadata.test.ts`) путями парсинга. ffmpeg не нужен.
 */

export type LegacyTextEncoding = 'cp1251' | 'latin1' | 'utf8-as-latin1' | 'utf16' | 'utf8'

/** Текст тега и кодировка, в которой теггер реально записал его байты. */
export interface TaggedText {
	text: string
	/** 'utf8' пишет фрейм ID3v2.4 (encoding 3); остальные — ID3v2.3. */
	encoding: LegacyTextEncoding
}

export interface LegacyMp3Tags {
	title?: TaggedText
	artist?: TaggedText
	album?: TaggedText
	genre?: TaggedText
}

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const total = parts.reduce((sum, part) => sum + part.length, 0)
	const result = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		result.set(part, offset)
		offset += part.length
	}
	return result
}

const asciiBytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

const latin1Bytes = (text: string): Uint8Array<ArrayBuffer> => {
	const bytes = new Uint8Array(text.length)
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index)
		if (code > 0xff) {
			throw new Error(`char U+${code.toString(16)} does not fit Latin-1: ${text}`)
		}
		bytes[index] = code
	}
	return bytes
}

const utf16leBytes = (text: string): Uint8Array<ArrayBuffer> => {
	const bytes = new Uint8Array(text.length * 2)
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index)
		bytes[index * 2] = code & 0xff
		bytes[index * 2 + 1] = code >> 8
	}
	return bytes
}

const CP1251_SPECIAL: Record<string, number> = {
	Ё: 0xa8,
	ё: 0xb8,
	'—': 0x97,
	'№': 0xb9,
}

/** Байты Windows-1251 для ASCII, кириллицы и типографских «—»/«№». */
const cp1251Bytes = (text: string): Uint8Array<ArrayBuffer> => {
	const bytes: number[] = []
	for (const char of text) {
		const code = char.codePointAt(0) as number
		if (code < 0x80) {
			bytes.push(code)
		} else if (code >= 0x4_10 && code <= 0x4_4f) {
			bytes.push(0xc0 + (code - 0x4_10))
		} else if (char in CP1251_SPECIAL) {
			bytes.push(CP1251_SPECIAL[char] as number)
		} else {
			throw new Error(`no cp1251 mapping for ${char} (U+${code.toString(16)})`)
		}
	}
	return new Uint8Array(bytes)
}

const bytesAsLatin1 = (bytes: Uint8Array): string => {
	let text = ''
	for (const byte of bytes) {
		text += String.fromCharCode(byte)
	}
	return text
}

/** Mojibake-строка: байты CP1251, прочитанные как Latin-1 («Ãðóïïà êðîâè»). */
export const cp1251AsLatin1 = (text: string): string => bytesAsLatin1(cp1251Bytes(text))

/** Mojibake-строка: байты UTF-8, прочитанные как Latin-1 («ÐšÐ¸Ð½Ð¾»). */
export const utf8AsLatin1 = (text: string): string => bytesAsLatin1(new TextEncoder().encode(text))

const syncsafe = (size: number): Uint8Array<ArrayBuffer> =>
	new Uint8Array([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])

/** ID3v2.3 frame: id(4) + size(4 plain BE) + flags(2) + payload. */
const frameV23 = (id: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
	const header = new Uint8Array(10)
	header.set(asciiBytes(id), 0)
	new DataView(header.buffer).setUint32(4, payload.length)
	return concatBytes([header, payload])
}

/** ID3v2.4 frame: id(4) + size(4 syncsafe) + flags(2) + payload. */
const frameV24 = (id: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
	const header = new Uint8Array(10)
	header.set(asciiBytes(id), 0)
	header.set(syncsafe(payload.length), 4)
	return concatBytes([header, payload])
}

const textFrameV23 = (id: string, tag: TaggedText): Uint8Array<ArrayBuffer> => {
	if (tag.encoding === 'utf16') {
		// encoding 1: UTF-16 LE с BOM
		return frameV23(
			id,
			concatBytes([new Uint8Array([0x01, 0xff, 0xfe]), utf16leBytes(tag.text)]),
		)
	}
	if (tag.encoding === 'utf8') {
		throw new Error('utf8 (ID3v2.4) tags cannot be mixed into an ID3v2.3 fixture')
	}
	const bytes =
		tag.encoding === 'cp1251'
			? cp1251Bytes(tag.text)
			: tag.encoding === 'utf8-as-latin1'
				? new TextEncoder().encode(tag.text)
				: latin1Bytes(tag.text)
	// encoding 0: заявлен ISO-8859-1, реальные байты — как записал теггер
	return frameV23(id, concatBytes([new Uint8Array([0x00]), bytes]))
}

const textFrameV24 = (id: string, tag: TaggedText): Uint8Array<ArrayBuffer> => {
	if (tag.encoding !== 'utf8') {
		throw new Error(`ID3v2.4 fixture supports only utf8 tags, got ${tag.encoding}`)
	}
	// encoding 3: UTF-8
	return frameV24(id, concatBytes([new Uint8Array([0x03]), new TextEncoder().encode(tag.text)]))
}

/** ~1 сек тишины: 40 валидных MPEG-1 Layer III кадров (128 kbps, 44100 Hz) по 417 байт. */
const silentAudio = (): Uint8Array<ArrayBuffer> => {
	const frame = new Uint8Array(417)
	frame[0] = 0xff
	frame[1] = 0xfb
	frame[2] = 0x90
	frame[3] = 0x00
	return concatBytes(Array.from({ length: 40 }, () => frame))
}

/**
 * MP3 с тегами в legacy-кодировках. Если хотя бы один тег имеет encoding 'utf8',
 * весь тег пишется как ID3v2.4 (где UTF-8 — encoding 3); иначе ID3v2.3.
 */
export const buildLegacyMp3 = (tags: LegacyMp3Tags): Uint8Array<ArrayBuffer> => {
	const entries: [string, TaggedText][] = []
	if (tags.title) {
		entries.push(['TIT2', tags.title])
	}
	if (tags.artist) {
		entries.push(['TPE1', tags.artist])
	}
	if (tags.album) {
		entries.push(['TALB', tags.album])
	}
	if (tags.genre) {
		entries.push(['TCON', tags.genre])
	}
	if (entries.length === 0) {
		return silentAudio()
	}

	const isV24 = entries.some(([, tag]) => tag.encoding === 'utf8')
	const frames = entries.map(([id, tag]) =>
		isV24 ? textFrameV24(id, tag) : textFrameV23(id, tag),
	)
	const body = concatBytes(frames)

	const header = new Uint8Array(10)
	header.set(asciiBytes('ID3'), 0)
	header[3] = isV24 ? 4 : 3
	header.set(syncsafe(body.length), 6)
	return concatBytes([header, body, silentAudio()])
}

/** MP3 без тегов: парсер обязан откатиться на имя файла (proper Unicode). */
export const buildUntaggedMp3 = (): Uint8Array<ArrayBuffer> => silentAudio()
