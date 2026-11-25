// @vitest-environment node

import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServerLibraryMiddleware } from '../library/middleware.ts'

const API_ROOT = '/api/server-library'
const AUDIO_CONTENT = '0123456789'

interface ErrorResponse {
	error: {
		code: string
		message: string
	}
}

interface FileListResponse {
	files: {
		path: string
		name: string
		size: number
		lastModified: number
	}[]
}

const expectError = async (response: Response, status: number, code: string) => {
	expect(response.status).toBe(status)
	expect(response.headers.get('content-type')).toContain('application/json')
	expect(response.headers.get('cache-control')).toBe('no-store')
	const body = (await response.json()) as ErrorResponse
	expect(body.error.code).toBe(code)
	expect(body.error.message.length).toBeGreaterThan(0)
}

describe('server library middleware', () => {
	let sandboxDirectory: string
	let musicDirectory: string
	let configuredMusicDirectory: string | undefined
	let server: Server | undefined
	let origin: string
	let nextPaths: string[]

	const writeFixture = async (relativePath: string, content = AUDIO_CONTENT) => {
		const absolutePath = join(musicDirectory, relativePath)
		await mkdir(dirname(absolutePath), { recursive: true })
		await writeFile(absolutePath, content)
		return absolutePath
	}

	const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init)

	const requestApi = (path: string, init?: RequestInit) => request(`${API_ROOT}${path}`, init)

	const fileRequest = (path: string, init?: RequestInit) =>
		requestApi(`/file?path=${encodeURIComponent(path)}`, init)

	beforeEach(async () => {
		sandboxDirectory = await mkdtemp(join(tmpdir(), 'snae-server-library-test-'))
		musicDirectory = join(sandboxDirectory, 'music')
		await mkdir(musicDirectory)
		configuredMusicDirectory = musicDirectory
		nextPaths = []

		const middleware = createServerLibraryMiddleware(() => configuredMusicDirectory)
		server = createServer((req, res) => {
			void middleware(req, res, (error) => {
				if (error) {
					res.writeHead(500)
					res.end('next error')
					return
				}

				nextPaths.push(req.url ?? '')
				res.writeHead(404)
				res.end('next')
			})
		})
		server.listen(0, '127.0.0.1')
		await once(server, 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') {
			throw new Error('Test server did not expose a TCP port')
		}
		origin = `http://127.0.0.1:${address.port}`
	})

	afterEach(async () => {
		if (server?.listening) {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => {
					if (error) {
						reject(error)
					} else {
						resolve()
					}
				})
			})
		}
		server = undefined
		await rm(sandboxDirectory, { force: true, recursive: true })
	})

	it('reports whether the library is enabled without exposing the configured path', async () => {
		const enabledResponse = await requestApi('/status')
		expect(enabledResponse.status).toBe(200)
		expect(enabledResponse.headers.get('cache-control')).toBe('no-store')
		await expect(enabledResponse.json()).resolves.toEqual({ enabled: true })

		configuredMusicDirectory = undefined
		const disabledResponse = await requestApi('/status')
		expect(disabledResponse.status).toBe(200)
		await expect(disabledResponse.json()).resolves.toEqual({ enabled: false })
		expect(
			JSON.stringify(await requestApi('/status').then((response) => response.json())),
		).not.toContain(sandboxDirectory)
	})

	it('returns an empty list for an empty library', async () => {
		const response = await requestApi('/files')
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ files: [] })
	})

	it('recursively lists supported audio with stable paths and metadata', async () => {
		const nestedPath = await writeFixture('Artist/Album/01 Song.MP3', 'nested')
		await writeFixture('A-first.flac', 'first')
		await writeFixture('Artist/Album/ignore.txt', 'not audio')
		await writeFixture('Artist/Album/cover.jpg', 'not audio')
		const modifiedAt = new Date('2024-02-03T04:05:06.000Z')
		await utimes(nestedPath, modifiedAt, modifiedAt)

		const response = await requestApi('/files')
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = (await response.json()) as FileListResponse
		const nestedStat = await stat(nestedPath)

		expect(body.files.map((file) => file.path)).toEqual([
			'A-first.flac',
			'Artist/Album/01 Song.MP3',
		])
		expect(body.files[1]).toEqual({
			path: 'Artist/Album/01 Song.MP3',
			name: '01 Song.MP3',
			size: 6,
			lastModified: Math.floor(nestedStat.mtimeMs),
		})
		expect(body.files.every((file) => Number.isInteger(file.lastModified))).toBe(true)
	})

	it('returns not found for unsupported existing files without reading them as audio', async () => {
		await writeFixture('notes.txt', 'private notes')
		const response = await fileRequest('notes.txt')
		await expectError(response, 404, 'FILE_NOT_FOUND')
	})

	it('serves a complete file and HEAD with audio headers', async () => {
		const absolutePath = await writeFixture('folder/song.mp3')
		const url = `${API_ROOT}/file?path=${encodeURIComponent('folder/song.mp3')}`

		const response = await requestApi(url.slice(API_ROOT.length))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('audio/mpeg')
		expect(response.headers.get('content-length')).toBe(String(AUDIO_CONTENT.length))
		expect(response.headers.get('accept-ranges')).toBe('bytes')
		expect(await response.text()).toBe(AUDIO_CONTENT)

		const headResponse = await requestApi(url.slice(API_ROOT.length), { method: 'HEAD' })
		expect(headResponse.status).toBe(200)
		expect(headResponse.headers.get('content-type')).toBe('audio/mpeg')
		expect(headResponse.headers.get('content-length')).toBe(String(AUDIO_CONTENT.length))
		expect(await headResponse.text()).toBe('')
		expect(await readFile(absolutePath, 'utf8')).toBe(AUDIO_CONTENT)
	})

	it.each([
		['aac', 'audio/aac'],
		['mp3', 'audio/mpeg'],
		['ogg', 'audio/ogg'],
		['wav', 'audio/wav'],
		['flac', 'audio/flac'],
		['m4a', 'audio/mp4'],
		['opus', 'audio/ogg'],
		['webm', 'audio/webm'],
	])('serves .%s with MIME %s', async (extension, mimeType) => {
		await writeFixture(`mime.${extension}`, extension)
		const response = await fileRequest(`mime.${extension}`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe(mimeType)
		expect(await response.text()).toBe(extension)
	})

	it.each([
		['bytes=2-5', '2345', 'bytes 2-5/10', '4'],
		['bytes=7-', '789', 'bytes 7-9/10', '3'],
		['bytes=-3', '789', 'bytes 7-9/10', '3'],
	])('serves valid range %s', async (range, expectedContent, contentRange, contentLength) => {
		const absolutePath = await writeFixture('range.mp3')
		const response = await fileRequest('range.mp3', { headers: { range } })

		expect(response.status).toBe(206)
		expect(response.headers.get('content-range')).toBe(contentRange)
		expect(response.headers.get('content-length')).toBe(contentLength)
		expect(response.headers.get('accept-ranges')).toBe('bytes')
		expect(await response.text()).toBe(expectedContent)
		expect(await readFile(absolutePath, 'utf8')).toBe(AUDIO_CONTENT)
	})

	it.each(['bytes=10-12', 'bytes=99-100', 'bytes=invalid', 'bytes=0-1,3-4'])(
		'rejects unsatisfiable or unsupported range %s',
		async (range) => {
			await writeFixture('range.mp3')
			const response = await fileRequest('range.mp3', { headers: { range } })
			expect(response.status).toBe(416)
			expect(response.headers.get('content-range')).toBe('bytes */10')
			await response.arrayBuffer()
		},
	)

	it('distinguishes missing files and unavailable or disabled directories', async () => {
		await expectError(await fileRequest('missing.mp3'), 404, 'FILE_NOT_FOUND')

		configuredMusicDirectory = join(sandboxDirectory, 'does-not-exist')
		await expectError(await requestApi('/status'), 503, 'DIRECTORY_UNAVAILABLE')
		await expectError(await requestApi('/files'), 503, 'DIRECTORY_UNAVAILABLE')
		await expectError(await fileRequest('missing.mp3'), 503, 'DIRECTORY_UNAVAILABLE')

		configuredMusicDirectory = undefined
		await expectError(await requestApi('/files'), 404, 'SERVER_LIBRARY_DISABLED')
		await expectError(await fileRequest('missing.mp3'), 404, 'SERVER_LIBRARY_DISABLED')
	})

	it('rejects a configured path that is not a readable directory', async () => {
		const fileInsteadOfDirectory = await writeFixture('not-a-directory.mp3')
		configuredMusicDirectory = fileInsteadOfDirectory
		await expectError(await requestApi('/files'), 503, 'DIRECTORY_UNAVAILABLE')
	})

	it.each([
		['', 'missing'],
		['/absolute/path.mp3', 'absolute'],
		['../outside.mp3', 'parent'],
		['folder/../../outside.mp3', 'nested parent'],
		['folder/./song.mp3', 'dot'],
		['folder\\song.mp3', 'backslash'],
		['song\0.mp3', 'NUL'],
	])('rejects unsafe path %s (%s)', async (path) => {
		const response = await fileRequest(path)
		await expectError(response, 400, 'INVALID_PATH')
	})

	it('rejects a missing path parameter', async () => {
		const response = await requestApi('/file')
		await expectError(response, 400, 'INVALID_PATH')
	})

	it('does not list or serve symlinks that escape the music directory', async () => {
		const outsideDirectory = join(sandboxDirectory, 'outside')
		await mkdir(outsideDirectory)
		const outsideFile = join(outsideDirectory, 'secret.mp3')
		await writeFile(outsideFile, 'secret')
		await symlink(outsideFile, join(musicDirectory, 'linked.mp3'))
		await symlink(outsideDirectory, join(musicDirectory, 'linked-directory'))

		const listResponse = await requestApi('/files')
		expect(listResponse.status).toBe(200)
		await expect(listResponse.json()).resolves.toEqual({ files: [] })
		await expectError(await fileRequest('linked.mp3'), 404, 'FILE_NOT_FOUND')
		await expectError(await fileRequest('linked-directory/secret.mp3'), 404, 'FILE_NOT_FOUND')
		expect(await readFile(outsideFile, 'utf8')).toBe('secret')
	})

	it('rejects mutation methods without changing files', async () => {
		const absolutePath = await writeFixture('readonly.mp3', 'original')
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			const response = await fileRequest('readonly.mp3', { method, body: 'changed' })
			expect(response.status).toBe(405)
			expect(response.headers.get('allow')).toContain('GET')
			expect(response.headers.get('allow')).toContain('HEAD')
			await response.arrayBuffer()
		}
		expect(await readFile(absolutePath, 'utf8')).toBe('original')
	})

	it('passes unrelated URLs to next without writing an API response', async () => {
		for (const path of ['/library', '/api/other']) {
			const response = await request(path)
			expect(response.status).toBe(404)
			expect(await response.text()).toBe('next')
		}
		expect(nextPaths).toEqual(['/library', '/api/other'])
	})
})
