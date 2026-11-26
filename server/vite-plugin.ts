import type { Plugin } from 'vite'
import { createAuthMiddleware } from './auth/middleware.ts'
import { createServerLibraryMiddleware } from './library/middleware.ts'

/**
 * Exposes the auth, user-state and server library APIs in `vite dev` and `vite preview`
 * through the same middleware as production. Auth must run before the library API,
 * which is session-gated.
 * @public
 */
export const serverLibraryPlugin = (): Plugin => {
	const authMiddleware = createAuthMiddleware()
	const middleware = createServerLibraryMiddleware()

	return {
		name: 'server-library-api',
		configureServer: (server) => {
			server.middlewares.use(authMiddleware)
			server.middlewares.use(middleware)
		},
		configurePreviewServer: (server) => {
			server.middlewares.use(authMiddleware)
			server.middlewares.use(middleware)
		},
	}
}
