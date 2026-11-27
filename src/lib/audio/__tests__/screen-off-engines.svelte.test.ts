// Контракт: CONTRACTS.md §14 — screen-off playback на уровне audio engines
// (независимые тесты #46, реализация — #45; автор тестов код не меняет).
// document.hidden моделирует выключенный экран: engine НЕ должен гейтовать
// ended/play/preload по visibility; play() обязан резюмировать suspended
// AudioContext (через graph.resume) до старта звука; gapless-старт
// (scheduleAt) не должен suspend'ить граф и глушить текущий трек.
// Границы модели: happy-dom не реализует ОС-ограничения мобильных браузеров
// (audio focus, Doze) — тесты фиксируют только JS-контракт §14.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wait } from '#lib/helpers/utils/wait.ts'
import type { AudioGraph } from '../audio-graph.svelte.ts'
import { AudioBufferEngine } from '../engine-buffer.svelte.ts'
import { createHTMLAudioEngine } from '../engine-html.svelte.ts'
import { makeGraph } from './test-utils.ts'

// ---------- document.hidden (screen-off) ----------

let originalHidden: PropertyDescriptor | undefined

const NOT_ALLOWED_RE = /NotAllowedError/

const setHidden = (hidden: boolean): void => {
	Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
	Object.defineProperty(document, 'visibilityState', {
		value: hidden ? 'hidden' : 'visible',
		configurable: true,
	})
}

beforeEach(() => {
	originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
})

afterEach(() => {
	if (originalHidden) {
		Object.defineProperty(document, 'hidden', originalHidden)
	}
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	vi.clearAllMocks()
})

// ---------- HTMLAudio engine: мок <audio> (паттерн engine-html.test) ----------

class MockAudio extends EventTarget {
	src = ''
	currentTime = 0
	duration = Number.NaN
	ended = false
	paused = true
	playbackRate = 1
	preservesPitch = true

	onloadedmetadata: (() => void) | null = null
	onerror: (() => void) | null = null

	play = vi.fn(() => {
		this.paused = false
		return Promise.resolve()
	})
	pause = vi.fn(() => {
		this.paused = true
	})
}

let mockAudio!: MockAudio

const stubAudioElement = (): void => {
	vi.stubGlobal(
		'Audio',
		class extends MockAudio {
			constructor() {
				super()
				mockAudio = this
			}
		},
	)
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url')
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
}

const makeHTMLEngine = async (opts: { signal?: AbortSignal } = {}) => {
	const graph = makeGraph()
	const controller = new AbortController()

	const promise = createHTMLAudioEngine({
		audioGraph: graph,
		blob: new Blob(['audio']),
		signal: opts.signal ?? controller.signal,
		playbackRate: 1,
		preservePitch: true,
		duration: 180,
	})

	mockAudio.duration = 180
	mockAudio.onloadedmetadata?.()

	const engine = await promise
	return { engine, graph, controller }
}

describe('HTMLAudio engine при screen-off (document.hidden)', () => {
	beforeEach(() => {
		stubAudioElement()
	})

	it('ended во время hidden вызывает onEnded (переход не ждёт видимого экрана)', async () => {
		const { engine } = await makeHTMLEngine()
		const onEnded = vi.fn()
		engine.onEnded = onEnded

		setHidden(true)
		mockAudio.dispatchEvent(new Event('ended'))

		expect(onEnded).toHaveBeenCalledTimes(1)
	})

	it('play() при suspended AudioContext резюмирует граф ДО старта элемента', async () => {
		const { engine, graph } = await makeHTMLEngine()
		setHidden(true)

		await engine.play()

		expect(graph.resume).toHaveBeenCalledTimes(1)
		expect(mockAudio.play).toHaveBeenCalledTimes(1)
		const resumeOrder = vi.mocked(graph.resume).mock.invocationCallOrder[0]
		const playOrder = mockAudio.play.mock.invocationCallOrder[0]
		expect(resumeOrder).toBeDefined()
		expect(playOrder).toBeDefined()
		if (resumeOrder === undefined || playOrder === undefined) {
			throw new Error('mocks were not called')
		}
		expect(resumeOrder).toBeLessThan(playOrder)
	})

	it('play() rejection (autoplay policy) пробрасывается вызывающему — не проглатывается', async () => {
		const { engine } = await makeHTMLEngine()
		setHidden(true)
		mockAudio.play.mockRejectedValueOnce(
			new DOMException('play() failed: NotAllowedError', 'NotAllowedError'),
		)

		await expect(engine.play()).rejects.toThrowError(NOT_ALLOWED_RE)
	})

	it('preload: engine создаётся (metadata + blob URL) и при hidden — preload не гейтован visibility', async () => {
		setHidden(true)
		const { engine } = await makeHTMLEngine()

		expect(engine.duration).toBe(180)
		expect(URL.createObjectURL).toHaveBeenCalled()
	})
})

// ---------- Buffer/gapless engine: мок mediabunny (паттерн engine-buffer.test) ----------

const sinkBehavior = { mode: 'hang' as 'hang' | 'one-buffer' }

const { MockInput, MockAudioBufferSink } = vi.hoisted(() => {
	class MockAudioBufferSink {
		buffers(): AsyncIterable<{ buffer: AudioBuffer; timestamp: number }> {
			const mode = sinkBehavior.mode
			return {
				[Symbol.asyncIterator]() {
					if (mode === 'hang') {
						return { next: () => new Promise<IteratorResult<never>>(() => {}) }
					}
					let yielded = false
					return {
						next: (): Promise<
							IteratorResult<{ buffer: AudioBuffer; timestamp: number }>
						> => {
							if (yielded) {
								return Promise.resolve({ done: true, value: undefined as never })
							}
							yielded = true
							return Promise.resolve({
								done: false,
								value: { buffer: { duration: 5 } as AudioBuffer, timestamp: 0 },
							})
						},
					}
				},
			}
		}
	}

	class MockInput {
		dispose = vi.fn()
	}

	return { MockAudioBufferSink, MockInput }
})

vi.mock('mediabunny', () => ({
	AudioBufferSink: MockAudioBufferSink,
	BlobSource: class {},
	Input: MockInput,
	canDecodeAudio: vi.fn(() => Promise.resolve(true)),
	FLAC: 'flac',
	PCM_AUDIO_CODECS: ['pcm-s16'],
	InputDisposedError: class InputDisposedError extends Error {
		constructor() {
			super('disposed')
			this.name = 'InputDisposedError'
		}
	},
}))

vi.mock('#lib/helpers/utils/ua.ts', () => ({
	isSafari: vi.fn(() => false),
}))

const makeBufferGraph = () => {
	const gainNode = { connect: vi.fn(), disconnect: vi.fn() }
	const context = {
		createGain: vi.fn(() => gainNode),
		createBufferSource: vi.fn(() => ({
			connect: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			disconnect: vi.fn(),
			buffer: null,
			playbackRate: { value: 1 },
			// 'ended' источника наступает, когда буфер доиграл (эмулируем сразу)
			addEventListener: vi.fn((event: string, cb: () => void) => {
				if (event === 'ended') {
					cb()
				}
			}),
		})),
		currentTime: 0,
		state: 'suspended' as AudioContextState,
	}
	return {
		context,
		inputNode: { connect: vi.fn() },
		resume: vi.fn(() => Promise.resolve()),
		suspend: vi.fn(() => Promise.resolve()),
		gainNode,
	}
}

const makeBufferEngine = (
	opts: { duration?: number; scheduleAt?: number; signal?: AbortSignal } = {},
) => {
	const controller = new AbortController()
	const graph = makeBufferGraph()
	const input = new MockInput()

	const engine = new AudioBufferEngine({
		audioGraph: graph as unknown as AudioGraph,
		duration: opts.duration ?? 180,
		input: input as never,
		audioTrack: {} as never,
		signal: opts.signal ?? controller.signal,
		playbackRate: 1,
		preservePitch: true,
		scheduleAt: opts.scheduleAt,
	})

	return { engine, graph, controller, input }
}

describe('Buffer/gapless engine при screen-off (document.hidden)', () => {
	beforeEach(() => {
		sinkBehavior.mode = 'hang'
	})

	it('play() при hidden и suspended контексте резюмирует граф после буферизации', async () => {
		sinkBehavior.mode = 'one-buffer'
		setHidden(true)
		const { engine, graph } = makeBufferEngine()

		void engine.play()
		await wait(50)

		// Первичный старт суспендит граф (не играть тишину), после буферизации
		// при wantsToPlay граф обязан быть возобновлён — иначе screen-off трек молчит.
		expect(graph.resume).toHaveBeenCalled()
		expect(engine.buffering).toBe(false)
	})

	it('ended во время hidden вызывает onEnded (все буферы отыграны)', async () => {
		sinkBehavior.mode = 'one-buffer'
		setHidden(true)
		const { engine } = makeBufferEngine({ duration: 5 })
		const onEnded = vi.fn()
		engine.onEnded = onEnded

		void engine.play()
		await wait(50)

		expect(engine.ended).toBe(true)
		expect(onEnded).toHaveBeenCalledTimes(1)
	})

	it('gapless-старт следующего трека (scheduleAt) при hidden НЕ suspend’ит граф и не глушит текущий', () => {
		setHidden(true)
		const { graph } = makeBufferEngine({ scheduleAt: 42 })

		// Gapless preload с future scheduleAt не должен трогать состояние графа:
		// suspend посреди трека оборвал бы звук при выключенном экране.
		expect(graph.suspend).not.toHaveBeenCalled()
	})
})
