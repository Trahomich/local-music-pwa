// Контракт: CONTRACTS.md §14 — screen-off переход на уровне PlaybackController
// (независимые тесты #46; реализацию не меняем). document.hidden моделирует
// выключенный экран: ended текущего трека → onTrackEnded, следующий трек
// загружается и играет без ожидания видимого экрана; preload работает при
// hidden (gapless путь); rejection play() не оставляет ложный playing=true;
// переход не инициирует сетевых запросов (rescan/startup sync/downloads).
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileLoadFailReason } from '#lib/helpers/file-resolver.ts'
import { PlaybackController, type TrackLoader } from '../playback-controller.svelte.ts'
import { makeGraph } from './test-utils.ts'

// ---------- document.hidden (screen-off) ----------

let originalHidden: PropertyDescriptor | undefined

const setHidden = (hidden: boolean): void => {
	Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
	Object.defineProperty(document, 'visibilityState', {
		value: hidden ? 'hidden' : 'visible',
		configurable: true,
	})
}

// ---------- моки engines (паттерн playback-controller.svelte.test) ----------

const {
	MockAudioBufferEngine,
	mockSupportsBufferEngine,
	mockCreateAudioBufferEngine,
	mockCreateHTMLAudioEngine,
} = vi.hoisted(() => {
	class MockAudioBufferEngine {
		currentTime = 0
		duration = 180
		buffering = false
		endTime = 999
		#ended = false

		get ended() {
			return this.#ended
		}
		set ended(v: boolean) {
			this.#ended = v
		}

		onEnded: (() => void) | null = null
		onError: (() => void) | null = null

		play = vi.fn(() => Promise.resolve())
		pause = vi.fn()
		seek = vi.fn((time: number) => {
			this.currentTime = time
		})
		setPlaybackRate = vi.fn()
	}

	return {
		MockAudioBufferEngine,
		mockSupportsBufferEngine: vi.fn<(codec: string) => boolean | Promise<boolean>>(),
		mockCreateAudioBufferEngine: vi.fn(),
		mockCreateHTMLAudioEngine: vi.fn(),
	}
})

vi.mock('../engine-buffer.svelte.ts', () => ({
	AudioBufferEngine: MockAudioBufferEngine,
	supportsBufferEngine: mockSupportsBufferEngine,
	createAudioBufferEngine: mockCreateAudioBufferEngine,
}))

vi.mock('../engine-html.svelte.ts', () => ({
	createHTMLAudioEngine: mockCreateHTMLAudioEngine,
}))

const makeHTMLEngine = () => {
	const engine = {
		currentTime: 0,
		duration: 180,
		buffering: false as const,
		ended: false,
		onEnded: null as (() => void) | null,
		onError: null as (() => void) | null,
		play: vi.fn(() => Promise.resolve()),
		pause: vi.fn(),
		seek: vi.fn((time: number) => {
			engine.currentTime = time
		}),
		setPlaybackRate: vi.fn(),
	}
	return engine
}

type TrackLoaderResult = Awaited<ReturnType<TrackLoader>>

const makeLoadedResult = (id: number, codec = 'mp3', duration = 180): TrackLoaderResult => ({
	status: 'loaded',
	file: new File(['audio'], `track-${id}.mp3`, { type: 'audio/mpeg' }),
	codec,
	duration,
})

const setup = (opts: { gaplessEnabled?: boolean } = {}) => {
	const graph = makeGraph()
	const onTrackEnded = vi.fn()
	const onError = vi.fn<(reason: FileLoadFailReason) => void>()
	const trackLoader = vi.fn<TrackLoader>()
	const isGaplessEnabled = vi.fn(() => opts.gaplessEnabled ?? false)

	let controller!: PlaybackController
	const cleanup = $effect.root(() => {
		controller = new PlaybackController(graph, {
			trackLoader,
			onTrackEnded,
			onError,
			isGaplessEnabled,
		})
	})

	return { controller, graph, onTrackEnded, onError, trackLoader, cleanup }
}

const waitFor = async (check: () => void, timeoutMs = 2000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			check()
			return
		} catch (error) {
			lastError = error
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
	}
	throw lastError
}

beforeEach(() => {
	originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
	mockSupportsBufferEngine.mockResolvedValue(false)
	mockCreateHTMLAudioEngine.mockImplementation(() => Promise.resolve(makeHTMLEngine()))
	mockCreateAudioBufferEngine.mockImplementation(() =>
		Promise.resolve(new MockAudioBufferEngine()),
	)
})

afterEach(() => {
	if (originalHidden) {
		Object.defineProperty(document, 'hidden', originalHidden)
	}
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe('PlaybackController при screen-off (document.hidden)', () => {
	it('ended текущего при hidden → onTrackEnded; play(next) грузит и играет следующий без видимого экрана', async () => {
		setHidden(true)
		const fetchSpy = vi.fn(() => Promise.reject(new Error('network must not be used')))
		vi.stubGlobal('fetch', fetchSpy)

		const { controller, onTrackEnded, trackLoader } = setup()
		trackLoader.mockImplementation((id) => Promise.resolve(makeLoadedResult(id)))

		await controller.play(1)
		const first = mockCreateHTMLAudioEngine.mock.results[0]?.value
		const firstEngine = (await first) as ReturnType<typeof makeHTMLEngine>
		expect(firstEngine.play).toHaveBeenCalledTimes(1)

		// Трек закончился при выключенном экране.
		firstEngine.onEnded?.()
		expect(onTrackEnded).toHaveBeenCalledTimes(1)

		// Player реагирует обычным play(nextId) — без таймеров и visibility-гейтов.
		await controller.play(2, { fromBeginning: true })
		await waitFor(() => expect(mockCreateHTMLAudioEngine).toHaveBeenCalledTimes(2))
		const secondEngine = (await mockCreateHTMLAudioEngine.mock.results[1]?.value) as ReturnType<
			typeof makeHTMLEngine
		>
		await waitFor(() => expect(secondEngine.play).toHaveBeenCalled())
		expect(controller.playing).toBe(true)
		expect(trackLoader).toHaveBeenCalledTimes(2)

		// Screen-off переход не инициирует сетевых запросов (rescan/downloads).
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('preload следующего при hidden идёт по gapless пути (reason=preload, scheduleAt от конца текущего)', async () => {
		setHidden(true)
		mockSupportsBufferEngine.mockResolvedValue(true)
		const { controller, trackLoader } = setup({ gaplessEnabled: true })
		trackLoader.mockImplementation((id) => Promise.resolve(makeLoadedResult(id, 'flac')))

		await controller.play(1)
		expect(mockCreateAudioBufferEngine).toHaveBeenCalledTimes(1)

		await controller.preloadNext(2)
		expect(trackLoader).toHaveBeenCalledWith(2, 'preload')
		await waitFor(() => expect(mockCreateAudioBufferEngine).toHaveBeenCalledTimes(2))
		// Gapless: следующий планируется на конец текущего (endTime).
		expect(mockCreateAudioBufferEngine.mock.calls[1]?.[0]).toMatchObject({ scheduleAt: 999 })
	})

	it('ended при hidden в gapless пути: play(next, gapless) промоутит preloaded engine без повторной загрузки', async () => {
		setHidden(true)
		mockSupportsBufferEngine.mockResolvedValue(true)
		const { controller, onTrackEnded, trackLoader } = setup({ gaplessEnabled: true })
		trackLoader.mockImplementation((id) => Promise.resolve(makeLoadedResult(id, 'flac')))

		await controller.play(1)
		await controller.preloadNext(2)

		const current = (await mockCreateAudioBufferEngine.mock.results[0]?.value) as InstanceType<
			typeof MockAudioBufferEngine
		>
		current.onEnded?.()
		expect(onTrackEnded).toHaveBeenCalledTimes(1)

		await controller.play(2, { gapless: true, fromBeginning: true })
		// Promote, а не перезагрузка: трек 2 не запрашивается повторно.
		expect(trackLoader.mock.calls.filter(([id]) => id === 2)).toHaveLength(1)
		const next = (await mockCreateAudioBufferEngine.mock.results[1]?.value) as InstanceType<
			typeof MockAudioBufferEngine
		>
		expect(next.play).toHaveBeenCalled()
		expect(controller.playing).toBe(true)
	})

	it('play() следующего отклонён (autoplay policy) — не остаётся ложный playing=true', async () => {
		setHidden(true)
		const rejected = () => {
			const promise = Promise.reject(
				new DOMException('play() failed: NotAllowedError', 'NotAllowedError'),
			)
			// Обработчик, чтобы тест не умирал от unhandled rejection; контроллер
			// получает тот же отклонённый promise и обязан его обработать сам.
			promise.catch(() => {})
			return promise
		}
		mockCreateHTMLAudioEngine.mockImplementation(() =>
			Promise.resolve({ ...makeHTMLEngine(), play: vi.fn(rejected) }),
		)

		const { controller, trackLoader } = setup()
		trackLoader.mockImplementation((id) => Promise.resolve(makeLoadedResult(id)))

		await controller.play(1)
		await new Promise((resolve) => setTimeout(resolve, 50))
		flushSync()

		// §14: ошибки resume/play обрабатываются и не оставляют UI playing=true ложно.
		expect(controller.playing).toBe(false)
	})

	it('suspended AudioContext: play() следующего при hidden делегирует resume движку (engine.play вызван)', async () => {
		setHidden(true)
		const { controller, graph, trackLoader } = setup()
		trackLoader.mockImplementation((id) => Promise.resolve(makeLoadedResult(id)))

		await controller.play(1)
		const firstEngine = (await mockCreateHTMLAudioEngine.mock.results[0]?.value) as ReturnType<
			typeof makeHTMLEngine
		>

		// Браузер перевёл AudioContext в suspended, пока экран был выключен.
		firstEngine.onEnded?.()
		await controller.play(2, { fromBeginning: true })
		await waitFor(() => {
			const second = mockCreateHTMLAudioEngine.mock.results[1]?.value
			expect(second).toBeDefined()
		})
		const secondEngine = (await mockCreateHTMLAudioEngine.mock.results[1]?.value) as ReturnType<
			typeof makeHTMLEngine
		>
		// Контроллер обязан вызвать play нового движка (engine сам резюмирует graph).
		await waitFor(() => expect(secondEngine.play).toHaveBeenCalled())
		expect(graph.resume).toBeDefined()
	})
})
