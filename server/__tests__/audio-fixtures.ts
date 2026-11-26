/**
 * Генераторы аудиофикстур для тестов серверного индекса (§10 CONTRACTS.md).
 * Всё генерируется программно — ffmpeg не нужен.
 */

/** Теги RIFF INFO, которые music-metadata маппит в common. */
export interface WavTags {
	INAM?: string // title
	IART?: string // artist
	IPRD?: string // album
	IGNR?: string // genre
	ICRD?: string // year
	ITRK?: string // track
}

const buildInfoChunk = (tags: WavTags): Buffer => {
	const subChunks: Buffer[] = []
	for (const [id, value] of Object.entries(tags)) {
		const text = Buffer.from(`${value}\0`, 'latin1')
		const sub = Buffer.alloc(8 + text.length + (text.length % 2))
		sub.write(id, 0, 'latin1')
		sub.writeUInt32LE(text.length, 4)
		text.copy(sub, 8)
		subChunks.push(sub)
	}
	const payload = Buffer.concat([Buffer.from('INFO', 'latin1'), ...subChunks])
	const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2))
	chunk.write('LIST', 0, 'latin1')
	chunk.writeUInt32LE(payload.length, 4)
	payload.copy(chunk, 8)
	return chunk
}

/**
 * Валидный PCM WAV (mono 8kHz 16-bit) с опциональными RIFF INFO тегами.
 * music-metadata парсит: title/artist/album/genre/year/track + duration + codec 'PCM'.
 */
export const buildWav = ({
	seconds = 0.05,
	tags = {},
}: {
	seconds?: number
	tags?: WavTags
} = {}): Buffer => {
	const sampleRate = 8000
	const bytesPerSample = 2
	const dataSize = Math.max(1, Math.floor(seconds * sampleRate)) * bytesPerSample
	const data = Buffer.alloc(dataSize)
	for (let i = 0; i < dataSize; i += 2) {
		data.writeInt16LE(Math.round(Math.sin(i / 20) * 10_000), i)
	}

	const fmt = Buffer.alloc(24)
	fmt.write('fmt ', 0, 'latin1')
	fmt.writeUInt32LE(16, 4)
	fmt.writeUInt16LE(1, 8) // PCM
	fmt.writeUInt16LE(1, 10) // mono
	fmt.writeUInt32LE(sampleRate, 12)
	fmt.writeUInt32LE(sampleRate * bytesPerSample, 16)
	fmt.writeUInt16LE(bytesPerSample, 20)
	fmt.writeUInt16LE(16, 22)

	const dataChunk = Buffer.alloc(8 + dataSize)
	dataChunk.write('data', 0, 'latin1')
	dataChunk.writeUInt32LE(dataSize, 4)
	data.copy(dataChunk, 8)

	const infoChunk = Object.keys(tags).length > 0 ? buildInfoChunk(tags) : Buffer.alloc(0)
	const riffPayload = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, dataChunk, infoChunk])
	const riff = Buffer.alloc(8 + riffPayload.length)
	riff.write('RIFF', 0, 'latin1')
	riff.writeUInt32LE(riffPayload.length, 4)
	riffPayload.copy(riff, 8)
	return riff
}

// ---------- MP3 с ID3v2.3 + APIC (для artwork-тестов) ----------

const syncsafe = (n: number): Buffer =>
	Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])

const id3Frame = (id: string, payload: Buffer): Buffer => {
	const frame = Buffer.alloc(10 + payload.length)
	frame.write(id, 0, 'latin1')
	frame.writeUInt32BE(payload.length, 4)
	payload.copy(frame, 10)
	return frame
}

const textFrame = (id: string, text: string): Buffer =>
	id3Frame(id, Buffer.concat([Buffer.from([0]), Buffer.from(`${text}\0`, 'latin1')]))

/** 1x1 PNG, детерминированные байты. */
export const PNG_1PX = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
)

/** 1x1 PNG с другим содержимым (прозрачный), чтобы проверять dedup по разным hash. */
export const PNG_1PX_ALT = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
	'base64',
)

const apicFrame = (image: Buffer, mime = 'image/png'): Buffer => {
	const header = Buffer.concat([
		Buffer.from([0]), // latin1
		Buffer.from(`${mime}\0`, 'latin1'),
		Buffer.from([3]), // cover front
		Buffer.from('\0', 'latin1'), // пустое описание
	])
	return id3Frame('APIC', Buffer.concat([header, image]))
}

export interface Mp3Tags {
	title?: string
	artist?: string
	album?: string
}

/**
 * MP3-подобный файл: ID3v2.3 (APIC + текстовые фреймы) + фиктивный аудиопоток.
 * music-metadata извлекает common-теги и picture; format/duration для фиктивного
 * аудио не определены — для тестов нормализации формата использовать WAV.
 */
export const buildMp3 = ({
	tags = {},
	image = PNG_1PX,
}: {
	tags?: Mp3Tags
	image?: Buffer | null
} = {}): Buffer => {
	const frames: Buffer[] = []
	if (image) {
		frames.push(apicFrame(image))
	}
	if (tags.title) {
		frames.push(textFrame('TIT2', tags.title))
	}
	if (tags.artist) {
		frames.push(textFrame('TPE1', tags.artist))
	}
	if (tags.album) {
		frames.push(textFrame('TALB', tags.album))
	}
	const framesBuf = Buffer.concat(frames)

	const id3Header = Buffer.alloc(10)
	id3Header.write('ID3', 0, 'latin1')
	id3Header[3] = 3 // v2.3
	syncsafe(framesBuf.length).copy(id3Header, 6)

	// фиктивный MPEG-фрейм-синк, чтобы расширение .mp3 выглядело правдоподобно
	const fakeAudio = Buffer.alloc(417, 0)
	fakeAudio[0] = 0xff
	fakeAudio[1] = 0xfb
	return Buffer.concat([id3Header, framesBuf, fakeAudio])
}

/**
 * Битый MP3: ID3v2.3 заявляет размер тега больше, чем размер файла.
 * music-metadata.parseFile стабильно бросает Id3v2ContentError
 * («ID3v2 tag size … exceeds remaining file size …»).
 */
export const buildCorruptAudio = (): Buffer => {
	const bytes = Buffer.alloc(20)
	bytes.write('ID3', 0, 'latin1')
	bytes[3] = 3 // v2.3
	bytes[8] = 0x7f // syncsafe size 16383 >> 10 оставшихся байт
	bytes[9] = 0x7f
	return bytes
}
