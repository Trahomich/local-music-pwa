import type { ServerFileEntity } from '#lib/library/types.ts'
import { isSupportedAudioFileName } from '#lib/server-library/api.ts'

export const isFileSystemAccessSupported: boolean = 'showDirectoryPicker' in globalThis

/** Entities backed by the local file system (or legacy in-memory files). */
export type LocalFileEntity = File | FileSystemFileHandle

export type FileEntity = LocalFileEntity | ServerFileEntity

export const isServerFileEntity = (entity: FileEntity): entity is ServerFileEntity =>
	'kind' in entity && entity.kind === 'server'

const isSupportedFile = (fileName: string): boolean => isSupportedAudioFileName(fileName)

export const getFileHandlesRecursively = async (
	directory: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle[]> => {
	const files: FileSystemFileHandle[] = []

	for await (const handle of directory.values()) {
		if (handle.kind === 'file') {
			const isValidFile = isSupportedFile(handle.name)

			if (isValidFile) {
				files.push(handle)
			}
		} else if (handle.kind === 'directory') {
			const additionalFiles = await getFileHandlesRecursively(handle)

			files.push(...additionalFiles)
		}
	}
	return files
}

const getFilesFromLegacyInputEvent = (e: Event): File[] => {
	const { files } = e.target as HTMLInputElement
	if (!files) {
		return []
	}

	return Array.from(files).filter((file) => isSupportedFile(file.name))
}

export const getFilesFromLegacyDirectory = (): Promise<File[]> => {
	const directoryElement = document.createElement('input')
	directoryElement.type = 'file'

	directoryElement.setAttribute('webkitdirectory', '')
	directoryElement.setAttribute('directory', '')

	const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<File[]>()

	const resolve = (files: File[]) => {
		directoryElement.remove()
		resolvePromise(files)
	}

	directoryElement.addEventListener('change', (e) => {
		resolve(getFilesFromLegacyInputEvent(e))
	})

	directoryElement.addEventListener('cancel', () => {
		resolve([])
	})

	directoryElement.addEventListener('error', (errorEvent) => {
		reject(new Error('Input error', { cause: errorEvent }))
	})

	// See https://stackoverflow.com/questions/47664777/javascript-file-input-onchange-not-working-ios-safari-only
	directoryElement.style.position = 'fixed'
	directoryElement.style.top = '-100000px'
	directoryElement.style.left = '-100000px'
	document.body.appendChild(directoryElement)

	directoryElement.click()

	return promise
}
