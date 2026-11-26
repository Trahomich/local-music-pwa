import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeUsernameKey } from '../../src/lib/auth/api.ts'

const SCRYPT_KEY_LENGTH = 64
const SCRYPT_SALT_LENGTH = 16
/**
 * Work factor for new password hashes. Kept moderate so one verify costs
 * ~100 ms even on slow CI hardware; online brute force is primarily capped
 * by the login rate limiter. Parameters travel with each stored hash, so the
 * factor can be raised later without invalidating existing passwords.
 */
const SCRYPT_N = 4096
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAX_MEMORY = 128 * 1024 * 1024
const SESSION_TOKEN_LENGTH = 32

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** @public */
export interface StoredUser {
	id: number
	username: string
	usernameKey: string
	passwordHash: string
}

/** `scrypt:<N>:<r>:<p>:<salt hex>:<key hex>` — parameters travel with the hash. */
const hashPassword = (password: string): string => {
	const salt = randomBytes(SCRYPT_SALT_LENGTH)
	const key = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: SCRYPT_MAX_MEMORY,
	})
	return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${key.toString('hex')}`
}

/** Bounds for parameters read back from the database, against corrupted rows. */
const isValidScryptParams = (n: number, r: number, p: number): boolean =>
	Number.isInteger(n) &&
	n >= 2 &&
	n <= 2 ** 16 &&
	(n & (n - 1)) === 0 &&
	Number.isInteger(r) &&
	r >= 1 &&
	r <= 32 &&
	Number.isInteger(p) &&
	p >= 1 &&
	p <= 32

const verifyPassword = (password: string, stored: string): boolean => {
	const [scheme, nRaw, rRaw, pRaw, saltHex, keyHex] = stored.split(':')
	if (scheme !== 'scrypt' || saltHex === undefined || keyHex === undefined) {
		return false
	}

	const n = Number(nRaw)
	const r = Number(rRaw)
	const p = Number(pRaw)
	if (!isValidScryptParams(n, r, p)) {
		return false
	}

	const salt = Buffer.from(saltHex, 'hex')
	const expectedKey = Buffer.from(keyHex, 'hex')
	if (expectedKey.length === 0) {
		return false
	}

	const key = scryptSync(password, salt, expectedKey.length, {
		N: n,
		r,
		p,
		maxmem: SCRYPT_MAX_MEMORY,
	})
	return key.length === expectedKey.length && timingSafeEqual(key, expectedKey)
}

/** @public */
export const hashSessionToken = (token: string): string =>
	createHash('sha256').update(token).digest('hex')

/** Runs `migration` inside a transaction and records its schema version. */
const migrateTo = (db: DatabaseSync, version: number, migrate: () => void): void => {
	const current = (db.prepare('PRAGMA user_version').get() as { user_version: number })
		.user_version
	if (current >= version) {
		return
	}

	db.exec('BEGIN IMMEDIATE')
	try {
		migrate()
		db.exec(`PRAGMA user_version = ${version}`)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

export interface AuthDb {
	readonly db: DatabaseSync
	createUser: (username: string, password: string) => StoredUser | 'taken'
	findUserByUsernameKey: (usernameKey: string) => StoredUser | undefined
	findUserById: (id: number) => StoredUser | undefined
	createSession: (userId: number, now: number) => { token: string; expiresAt: number }
	findSessionUser: (tokenHash: string, now: number) => StoredUser | undefined
	deleteSession: (tokenHash: string) => void
	deleteExpiredSessions: (now: number) => void
	close: () => void
}

/**
 * Opens (creating if needed) `auth.sqlite` inside `dataDir` and applies the auth schema.
 * The returned connection is the single owner of the file; user-state tables are added
 * by their own domain through the same connection.
 * @public
 */
export const createAuthDb = (dataDir: string): AuthDb => {
	mkdirSync(dataDir, { recursive: true })
	const db = new DatabaseSync(resolve(dataDir, 'auth.sqlite'))
	db.exec('PRAGMA journal_mode = WAL')
	db.exec('PRAGMA foreign_keys = ON')

	migrateTo(db, 1, () => {
		db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				username TEXT NOT NULL,
				username_key TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				token_hash TEXT NOT NULL UNIQUE,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
		`)
	})

	const createUser = (username: string, password: string): StoredUser | 'taken' => {
		const usernameKey = normalizeUsernameKey(username)
		try {
			const result = db
				.prepare(
					'INSERT INTO users (username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?)',
				)
				.run(username, usernameKey, hashPassword(password), Date.now())
			const user = findUserById(Number(result.lastInsertRowid))
			if (user === undefined) {
				throw new Error('User insert did not produce a readable row')
			}
			return user
		} catch (error) {
			if (isUniqueViolation(error)) {
				return 'taken'
			}
			throw error
		}
	}

	const findUserByUsernameKey = (usernameKey: string): StoredUser | undefined => {
		const row = db
			.prepare(
				'SELECT id, username, username_key, password_hash FROM users WHERE username_key = ?',
			)
			.get(usernameKey) as
			| { id: number; username: string; username_key: string; password_hash: string }
			| undefined
		return row === undefined
			? undefined
			: {
					id: row.id,
					username: row.username,
					usernameKey: row.username_key,
					passwordHash: row.password_hash,
				}
	}

	const findUserById = (id: number): StoredUser | undefined => {
		const row = db
			.prepare('SELECT id, username, username_key, password_hash FROM users WHERE id = ?')
			.get(id) as
			| { id: number; username: string; username_key: string; password_hash: string }
			| undefined
		return row === undefined
			? undefined
			: {
					id: row.id,
					username: row.username,
					usernameKey: row.username_key,
					passwordHash: row.password_hash,
				}
	}

	const createSession = (userId: number, now: number): { token: string; expiresAt: number } => {
		// Only the SHA-256 hash of the token is persisted; the plaintext token lives in the cookie
		const token = randomBytes(SESSION_TOKEN_LENGTH).toString('hex')
		const expiresAt = now + SESSION_TTL_MS
		db.prepare(
			'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
		).run(userId, hashSessionToken(token), now, expiresAt)
		return { token, expiresAt }
	}

	const findSessionUser = (tokenHash: string, now: number): StoredUser | undefined => {
		const row = db
			.prepare(
				`SELECT users.id, users.username, users.username_key, users.password_hash, sessions.expires_at
				 FROM sessions JOIN users ON users.id = sessions.user_id
				 WHERE sessions.token_hash = ?`,
			)
			.get(tokenHash) as
			| {
					id: number
					username: string
					username_key: string
					password_hash: string
					expires_at: number
			  }
			| undefined

		if (row === undefined) {
			return undefined
		}
		if (row.expires_at <= now) {
			db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
			return undefined
		}
		return {
			id: row.id,
			username: row.username,
			usernameKey: row.username_key,
			passwordHash: row.password_hash,
		}
	}

	const deleteSession = (tokenHash: string): void => {
		db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
	}

	const deleteExpiredSessions = (now: number): void => {
		db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
	}

	return {
		db,
		createUser,
		findUserByUsernameKey,
		findUserById,
		createSession,
		findSessionUser,
		deleteSession,
		deleteExpiredSessions,
		close: () => {
			db.close()
		},
	}
}

/** SQLITE_CONSTRAINT_UNIQUE (2067) or SQLITE_CONSTRAINT_PRIMARYKEY (1555). */
/** @public */
export const isUniqueViolation = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	'errcode' in error &&
	(error.errcode === 2067 || error.errcode === 1555)

/** Timing-safe password check that never throws on malformed stored hashes. */
/** @public */
export const checkPassword = (password: string, storedHash: string): boolean =>
	verifyPassword(password, storedHash)
