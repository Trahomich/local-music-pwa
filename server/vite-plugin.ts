import type { Plugin } from 'vite'
import { createServerLibraryMiddleware } from './library/middleware.ts'

/**
 * Exposes the server library API in `vite dev` and `vite preview` through the same middleware as production.
 * @public
 */
export const serverLibraryPlugin = (): Plugin => {
	const middleware = createServerLibraryMiddleware()

	return {
		name: 'server-library-api',
		configureServer: (server) => {
			server.middlewares.use(middleware)
		},
		configurePreviewServer: (server) => {
			server.middlewares.use(middleware)
		},
	}
}
