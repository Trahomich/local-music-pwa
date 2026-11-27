// Контракт: CONTRACTS.md §14 — screen-off переход на уровне PlayerStore
// (независимые тесты #46; реализацию не меняем). document.hidden моделирует
// выключенный экран. Проверяется, что ended → следующий трек сохраняет
// семантику repeat none/one/all и shuffle, preload продолжает работать при
// hidden, переход не инициирует сетевых запросов и не дублирует запуски,
// history фиксирует переход. Offline downloaded трек: trackLoader получает
// файл без сети — здесь фиксируем отсутствие fetch на переходе.
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerStore } from '#lib/stores/player/player.svelte.ts'

// ---------- моки (паттерн player.svelte.test) ----------

interface MockOptions {
	onTrackEnded: () => void
	onError: (reason: string) => void
	isGaplessEnabled: () => boolean
	trackLoader: (trackId: number, reason: string) => Promise<unknown>
}

const { MockPlaybackController, mockHistory, controllerRef, databaseChange } = vi.hoisted(() => {
	const controllerRef: { instance: unknown; options: unknown } = {
		instance: null,
		options: null,
	}

	const mockHistory = {
		begin: vi.fn(),
		update: vi.fn(),
		complete: vi.fn(),
	}
	const databaseChange: { listener: ((changes: readonly unknown[]) => void) | null } = {
		listener: null,
	}

	class MockPlaybackController {
		playing = $state(false)
		duration = $state(0)
		currentTime = $state(0)
		loading = $state(false)

		play = vi.fn((_trackId: number, _opts?: unknown) => {
			this.playing = true
			return Promise.resolve()
		})
		pause = vi.fn(() => {
			this.playing = false
		})
		seek = vi.fn((time: number) => {
			this.currentTime = time
		})
		setPlaybackRate = vi.fn()
		preloadNext = vi.fn(() => Promise.resolve())
		abortNext = vi.fn()
		abort = vi.fn(() => {
			this.playing = false
			this.duration = 0
		})

		constructor(_graph: unknown, options: MockOptions) {
			controllerRef.instance = this
			controllerRef.options = options
		}
	}

	return { MockPlaybackController, mockHistory, controllerRef, databaseChange }
})

vi.mock('#lib/audio/playback-controller.svelte.ts', () => ({
	PlaybackController: MockPlaybackController,
}))

vi.mock('#lib/audio/audio-graph.svelte.ts', () => ({
	AudioGraph: class {
		initialized = false
		setVolume = vi.fn()
		dispose = vi.fn()
	},
}))

vi.mock('#lib/stores/player/equalizer.svelte.ts', () => ({
	EqualizerStore: class {
		init() {}
		resumeContext() {
			return Promise.resolve()
		}
		connectSource() {}
	},
}))

vi.mock('#lib/stores/player/media-session.svelte.ts', () => ({
	MediaSessionController: class {
		updatePosition() {}
	},
}))

vi.mock('#lib/stores/player/play-history-tracker.ts', () => ({
	PlayHistoryTracker: class {
		begin = mockHistory.begin
		update = mockHistory.update
		complete = mockHistory.complete
	},
}))

vi.mock('#lib/db/events.ts', () => ({
	onDatabaseChange: vi.fn((listener) => {
		databaseChange.listener = listener
		return () => {
			databaseChange.listener = null
		}
	}),
	dispatchDatabaseChangedEvent: vi.fn(),
}))

interface QueryTrack {
	id: number
	name: string
	duration: number
}

const queryTracks = new Map<number, QueryTrack>()

vi.mock('#lib/library/get/value-queries.ts', () => ({
	createTrackQuery: (idGetter: () => number, _opts?: unknown) => ({
		get value() {
			return queryTracks.get(idGetter())
		},
		get error() {
			return undefined
		},
		get status() {
			return 'loaded'
		},
		get loading() {
			return false
		},
	}),
}))

vi.mock('#lib/helpers/persist.svelte.ts', () => ({
	persist: vi.fn(),
}))

vi.mock('#lib/helpers/create-managed-artwork.svelte.ts', () => ({
	createManagedArtwork: () => () => undefined,
}))

vi.mock('#lib/helpers/file-resolver.ts', () => ({
	resolveTrackFile: vi.fn(() =>
		Promise.resolve({ status: 'loaded', file: new File([''], 'track.mp3') }),
	),
}))

vi.mock('#lib/library/get/value.ts', () => ({
	getLibraryValue: vi.fn((_store: string, trackId: number) =>
		Promise.resolve({
			directory: -1,
			format: { codec: 'mp3' },
			duration: 180,
			file: new File([''], `track-${trackId}.mp3`),
			uuid: `uuid-${trackId}`,
		}),
	),
}))

const seedTrack = (id: number) => {
	queryTracks.set(id, { id, name: `Track ${id}`, duration: 180 })
}

// ---------- document.hidden (screen-off) ----------

let originalHidden: PropertyDescriptor | undefined

const setHidden = (hidden: boolean): void => {
	Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
	Object.defineProperty(document, 'visibilityState', {
		value: hidden ? 'hidden' : 'visible',
		configurable: true,
	})
}

let player!: PlayerStore
let cleanupPlayer: () => void
let ctrl: InstanceType<typeof MockPlaybackController> = null as never
let opts: MockOptions = null as never

beforeEach(() => {
	originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
	cleanupPlayer = $effect.root(() => {
		player = new PlayerStore()
	})
	flushSync()
	vi.clearAllMocks()
	ctrl = controllerRef.instance as InstanceType<typeof MockPlaybackController>
	opts = controllerRef.options as MockOptions
})

afterEach(() => {
	cleanupPlayer()
	if (originalHidden) {
		Object.defineProperty(document, 'hidden', originalHidden)
	}
	vi.unstubAllGlobals()
	vi.clearAllMocks()
	queryTracks.clear()
	databaseChange.listener = null
})

const startTwoTrackQueue = () => {
	seedTrack(1)
	seedTrack(2)
	player.playFrom(0, [1, 2])
	flushSync()
	vi.clearAllMocks()
}

describe('PlayerStore screen-off переход (document.hidden)', () => {
	it('repeat none: ended при hidden → следующий трек gapless+fromBeginning, history complete/begin', () => {
		setHidden(true)
		startTwoTrackQueue()

		opts.onTrackEnded()
		flushSync()

		expect(mockHistory.complete).toHaveBeenCalledTimes(1)
		expect(ctrl.play).toHaveBeenCalledTimes(1)
		expect(ctrl.play).toHaveBeenCalledWith(2, { gapless: true, fromBeginning: true })
		expect(mockHistory.begin).toHaveBeenCalledWith(2)
		// Ровно один запуск: MediaSession/ended не дублируют очередь.
		expect(ctrl.pause).not.toHaveBeenCalled()
	})

	it('repeat one: ended при hidden → повтор текущего трека с начала, без advance очереди', () => {
		setHidden(true)
		startTwoTrackQueue()
		player.repeat = 'one'
		flushSync()
		vi.clearAllMocks()

		opts.onTrackEnded()
		flushSync()

		expect(ctrl.play).toHaveBeenCalledTimes(1)
		expect(ctrl.play).toHaveBeenCalledWith(1, { gapless: true, fromBeginning: true })
		expect(player.queue.current?.trackId).toBe(1)
	})

	it('repeat all: ended на последнем треке при hidden → очередь зацикливается на первый', () => {
		setHidden(true)
		seedTrack(1)
		seedTrack(2)
		player.playFrom(1, [1, 2])
		player.repeat = 'all'
		flushSync()
		vi.clearAllMocks()

		opts.onTrackEnded()
		flushSync()

		expect(ctrl.play).toHaveBeenCalledTimes(1)
		expect(ctrl.play).toHaveBeenCalledWith(1, { gapless: true, fromBeginning: true })
		expect(player.queue.current?.trackId).toBe(1)
	})

	it('shuffle: ended при hidden → играет следующий по shuffle-порядку (не тот же трек)', () => {
		setHidden(true)
		seedTrack(1)
		seedTrack(2)
		seedTrack(3)
		player.playFrom('shuffle', [1, 2, 3])
		flushSync()
		const currentId = player.queue.current?.trackId
		vi.clearAllMocks()

		opts.onTrackEnded()
		flushSync()

		expect(ctrl.play).toHaveBeenCalledTimes(1)
		const playedId = ctrl.play.mock.calls[0]?.[0]
		expect(playedId).not.toBe(currentId)
		expect([1, 2, 3]).toContain(playedId)
		expect(player.queue.current?.trackId).toBe(playedId)
	})

	it('preload при hidden не отключается: remaining ≤ 10с → preloadNext(next) вызван', () => {
		setHidden(true)
		startTwoTrackQueue()
		ctrl.duration = 180
		ctrl.currentTime = 175
		flushSync()

		expect(ctrl.preloadNext).toHaveBeenCalledWith(2)
	})

	it('screen-off переход не делает сетевых запросов (ни rescan, ни повторных downloads)', () => {
		setHidden(true)
		const fetchSpy = vi.fn(() => Promise.reject(new Error('network must not be used')))
		vi.stubGlobal('fetch', fetchSpy)
		startTwoTrackQueue()

		opts.onTrackEnded()
		flushSync()
		// И preload-путь при hidden тоже офлайн-безопасен.
		ctrl.duration = 180
		ctrl.currentTime = 179
		flushSync()

		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('repeat none + конец очереди при hidden: пауза, без ложных запусков', () => {
		setHidden(true)
		seedTrack(1)
		player.playFrom(0, [1])
		flushSync()
		vi.clearAllMocks()

		opts.onTrackEnded()
		flushSync()

		expect(ctrl.pause).toHaveBeenCalledTimes(1)
		expect(ctrl.play).not.toHaveBeenCalled()
	})
})
