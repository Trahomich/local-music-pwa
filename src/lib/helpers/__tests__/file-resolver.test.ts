// Контракт: CONTRACTS.md §5 — resolveTrackFile получает server entity без FS permission,
// делает fetch file API; 404 -> not-found, прочие сетевые/HTTP ошибки -> error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTrackFile } from '#lib/helpers/file-resolver.ts'
import { SERVER_DIRECTORY_ID, type ServerFileEntity } from '#lib/library/types.ts'
import {
	installServerLibraryMock,
	serverFileBody,
	serverFileDescriptor,
} from '#lib/server-library/__tests__/server-library-mock.ts'

const serverEntity = (path: string): ServerFileEntity => ({
	...serverFileDescriptor(path),
	kind: 'server',
})

describe('resolveTrackFile with a server file entity', () => {
	let mock: ReturnType<typeof installServerLibraryMock>

	beforeEach(() => {
		mock = installServerLibraryMock()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('loads a File without any filesystem permission', async () => {
		const entity = serverEntity('Artist/Album/01 Song.mp3')

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
		})

		expect(result.status).toBe('loaded')
		if (result.status !== 'loaded') {
			return
		}

		expect(result.file.name).toBe('01 Song.mp3')
		expect(result.file.type).toBe('audio/mpeg')
		expect(result.file.lastModified).toBe(entity.lastModified)
		expect(await result.file.text()).toBe(serverFileBody(entity.path))

		expect(mock.requests).toHaveLength(1)
		expect(mock.requests[0]?.method).toBe('GET')
		expect(mock.requests[0]?.pathname).toBe('/api/server-library/file')
		expect(mock.requests[0]?.queryPath).toBe(entity.path)
	})

	it('assigns the contract MIME type for every supported extension', async () => {
		const cases: [string, string][] = [
			['track.aac', 'audio/aac'],
			['track.mp3', 'audio/mpeg'],
			['track.ogg', 'audio/ogg'],
			['track.wav', 'audio/wav'],
			['track.flac', 'audio/flac'],
			['track.m4a', 'audio/mp4'],
			['track.opus', 'audio/ogg'],
			['track.webm', 'audio/webm'],
		]

		for (const [path, mime] of cases) {
			const result = await resolveTrackFile({
				directoryId: SERVER_DIRECTORY_ID,
				entity: serverEntity(path),
				askPermission: false,
			})

			if (result.status !== 'loaded') {
				throw new Error(`expected ${path} to load`)
			}
			expect(result.file.type).toBe(mime)
		}

		expect(mock.requests).toHaveLength(cases.length)
	})

	it('encodes special characters in the request URL', async () => {
		const entity = serverEntity('микс/#1?/трек ü.mp3')

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: false,
		})

		expect(result.status).toBe('loaded')
		expect(mock.requests[0]?.queryPath).toBe(entity.path)
	})

	it('maps a 404 from the file endpoint to not-found', async () => {
		mock.state.fileStatuses['gone.mp3'] = 404

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity: serverEntity('gone.mp3'),
			askPermission: false,
		})

		expect(result.status).toBe('not-found')
	})

	it('maps a 500 from the file endpoint to error', async () => {
		mock.state.fileStatuses['broken.mp3'] = 500

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity: serverEntity('broken.mp3'),
			askPermission: false,
		})

		expect(result.status).toBe('error')
	})

	it('maps a network failure to error', async () => {
		mock.state.networkError = true

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity: serverEntity('unreachable.mp3'),
			askPermission: false,
		})

		expect(result.status).toBe('error')
	})

	it('never touches filesystem permission APIs for server entities', async () => {
		const permissionSpies = {
			queryPermission: vi.fn(),
			requestPermission: vi.fn(),
			getFile: vi.fn(),
		}
		const entity = Object.assign(serverEntity('Artist/Album/01 Song.mp3'), permissionSpies)

		const result = await resolveTrackFile({
			directoryId: SERVER_DIRECTORY_ID,
			entity,
			askPermission: true,
		})

		expect(result.status).toBe('loaded')
		expect(permissionSpies.queryPermission).not.toHaveBeenCalled()
		expect(permissionSpies.requestPermission).not.toHaveBeenCalled()
		expect(permissionSpies.getFile).not.toHaveBeenCalled()
	})
})
