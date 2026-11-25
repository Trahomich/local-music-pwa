import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

/** @public */
export const logChunkSizePlugin = (): Plugin => ({
	name: 'vite-plugin-log-chunk-size',
	apply: 'build',
	enforce: 'post',
	writeBundle() {
		if (this.environment.name !== 'client') {
			return
		}

		const dirSize = async (directory: string) => {
			const jsInfo = { size: 0, count: 0 }
			const totalInfo = { size: 0, count: 0 }

			const processDirectory = async (dir: string) => {
				const files = readdirSync(dir)

				for (const file of files) {
					const filePath = path.join(dir, file)
					const stat = statSync(filePath)

					if (stat.isDirectory()) {
						await processDirectory(filePath)
					} else {
						if (file.endsWith('.js')) {
							jsInfo.size += stat.size
							jsInfo.count += 1
						}
						totalInfo.size += stat.size
						totalInfo.count += 1
					}
				}
			}

			await processDirectory(directory)

			return { jsInfo, totalInfo }
		}

		// The adapter writes ./build after the client bundle, and on slow machines that
		// takes longer than any fixed delay — poll for it instead of guessing. Logging
		// chunk sizes must never fail the build, so every error here is swallowed.
		const directory = './build/_app/immutable'
		const deadline = Date.now() + 60_000
		const poll = async () => {
			try {
				if (!existsSync(directory)) {
					if (Date.now() < deadline) {
						setTimeout(() => void poll(), 250)
					}
					return
				}

				const { jsInfo, totalInfo } = await dirSize(directory)
				console.info(
					'Size of JS chunks:',
					jsInfo.size / 1024,
					'KB. Files count:',
					jsInfo.count,
				)
				console.info(
					'Size of all files:',
					totalInfo.size / 1024,
					'KB. Files count:',
					totalInfo.count,
				)
			} catch {
				// Ignored: chunk size logging is best-effort only
			}
		}

		void poll()
	},
})
