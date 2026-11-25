// Контракт: CONTRACTS.md §3-4 — getServerLibraryFileUrl кодирует relative path в query `path`.
import { describe, expect, it } from 'vitest'
import { getServerLibraryFileUrl } from '#lib/server-library/api.ts'

const FILE_ENDPOINT_PATHNAME = '/api/server-library/file'

describe('getServerLibraryFileUrl', () => {
	it.each([
		'Artist/Album/01 Song.mp3',
		'с пробелами/трек ü.mp3',
		'special/#hash?.mp3',
		'100% organic?.flac',
		'a&b=c/d+e.opus',
		'depth/one/two/three/four.wav',
	])('round-trips %s through the path query param', (path) => {
		const url = new URL(getServerLibraryFileUrl(path), 'http://test.local')

		expect(url.pathname).toBe(FILE_ENDPOINT_PATHNAME)
		expect(url.searchParams.get('path')).toBe(path)
	})

	it('returns a same-origin relative URL', () => {
		const url = getServerLibraryFileUrl('Artist/Album/01 Song.mp3')

		expect(url.startsWith('/')).toBe(true)
	})

	it('does not truncate paths containing # or ?', () => {
		const path = 'mix/#1?/track.mp3'
		const url = new URL(getServerLibraryFileUrl(path), 'http://test.local')

		expect(url.hash).toBe('')
		expect(url.searchParams.get('path')).toBe(path)
	})
})
