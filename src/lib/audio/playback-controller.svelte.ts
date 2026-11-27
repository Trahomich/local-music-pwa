import type { FileLoadFailReason } from '#lib/helpers/file-resolver.ts'
import { isAbortError } from '#lib/helpers/utils/errors.ts'
import type { AudioGraph } from './audio-graph.svelte.ts'
import type { AudioEngineOptions } from './engine.ts'
import {
	AudioBufferEngine,
	createAudioBufferEngine,
	supportsBufferEngine,
} from './engine-buffer.svelte.ts'
import { createHTMLAudioEngine, type HTMLAudioEngine } from './engine-html.svelte.ts'

type AudioEngine = AudioBufferEngine | HTMLAudioEngine

type TrackLoaderResult =
	| { status: 'loaded'; file: File; codec: string; duration: number }
	| { status: FileLoadFailReason }

type TrackLoadReason = 'load' | 'preload'

export type TrackLoader = (trackId: number, reason: TrackLoadReason) => Promise<TrackLoaderResult>

type EngineLoadResult =
	| { status: 'loaded'; engine: AudioEngine }
	| { status: 'aborted' }
	| { status: 'failed'; reason: FileLoadFailReason }

interface EngineStateIdle {
	status: 'idle'
}
interface EngineStateLoading {
	status: 'loading'
	trackId: number
	controller: AbortController
}
interface EngineStateReady {
	status: 'ready'
	trackId: number
	engine: AudioEngine
	controller: AbortController
}
interface EngineStateFailed {
	status: 'failed'
	trackId: number
	reason: FileLoadFailReason | 'preload-failed'
}

type EngineState = EngineStateIdle | EngineStateLoading | EngineStateReady | EngineStateFailed

const idle = (): EngineStateIdle => ({ status: 'idle' })

const failed = (trackId: number, reason: EngineStateFailed['reason']): EngineStateFailed => ({
	status: 'failed',
	trackId,
	reason,
})

const createStateTransition = (trackId: number) => {
	const controller = new AbortController()

	return {
		loading: (): EngineStateLoading => ({ status: 'loading', trackId, controller }),
		ready: (engine: AudioEngine): EngineStateReady => ({
			status: 'ready',
			trackId,
			engine,
			controller,
		}),
		failed: (reason: EngineStateFailed['reason']): EngineStateFailed => failed(trackId, reason),
	}
}

interface AudioPlayerOptions {
	trackLoader: TrackLoader
	onTrackEnded: () => void
	onError: (reason: FileLoadFailReason) => void
	isGaplessEnabled: () => boolean
}

interface TryLoadEngineOptions {
	signal: AbortSignal
	// Using getter so that we can get latest value, only when we actually start loading the audio
	scheduleAt?: () => number
	mustBeGapless?: boolean
	/**
	 * Forbid the buffer engine for this load. A buffer engine created without
	 * `scheduleAt` suspends the shared graph while decoding, which would
	 * silence the track that is currently playing during a preload.
	 */
	mustBeHtml?: boolean
	reason: TrackLoadReason
}

interface SwitchAndPlayOptions {
	gapless?: boolean
	fromBeginning?: boolean
}

/** @public */
export class PlaybackController {
	readonly #graph: AudioGraph
	readonly #options: AudioPlayerOptions

	#current: Readonly<EngineState> = $state.raw(idle())
	#next: Readonly<EngineState> = $state.raw(idle())

	#playbackRate = 1
	#preservePitch = true

	playing = $state(false)
	duration = $state(0)

	readonly loading = $derived.by(() => {
		const current = this.#current

		if (current.status === 'loading') {
			return true
		}

		if (current.status === 'ready') {
			return current.engine.buffering
		}

		return false
	})
	currentTime = $derived(this.#current.status === 'ready' ? this.#current.engine.currentTime : 0)

	constructor(graph: AudioGraph, options: AudioPlayerOptions) {
		this.#graph = graph
		this.#options = options
		graph.onInterruptionFailed = () => this.#handleInterruptionFailed()
	}

	/**
	 * The context was suspended externally and the browser refused to resume
	 * it without a fresh user gesture (CONTRACTS.md §14): stop honestly
	 * instead of keeping a false `playing=true`. No-op when already paused.
	 */
	#handleInterruptionFailed(): void {
		if (this.playing) {
			this.playing = false
			this.#options.onError('error')
		}
	}

	/**
	 * Load and play a track into the current slot.
	 * Idempotent: calling with the same trackId while already loading or ready will play same track without reloading.
	 */
	async play(trackId: number, options: SwitchAndPlayOptions = {}): Promise<void> {
		this.playing = true
		const current = this.#current
		if (current.status === 'ready' && current.trackId === trackId) {
			if (options.fromBeginning || current.engine.ended) {
				this.seek(0)
			}

			this.#playEngine(current.engine)

			return
		}

		if (current.status === 'loading' && current.trackId === trackId) {
			return
		}

		this.#teardownCurrent()

		const next = this.#next
		if (options.gapless && next.status === 'ready' && next.trackId === trackId) {
			this.#next = idle()
			this.#promoteToCurrent(next)
			return
		}

		this.#teardownAndIdleNext()

		const transition = createStateTransition(trackId)
		this.#current = transition.loading()

		const result = await this.#tryLoadingEngine(trackId, {
			reason: 'load',
			signal: this.#current.controller.signal,
		})

		if (result.status === 'aborted') {
			return
		}

		if (result.status === 'failed') {
			this.playing = false
			this.#current = transition.failed(result.reason)
			this.#options.onError(result.reason)
			return
		}

		this.#promoteToCurrent(transition.ready(result.engine))
	}

	/**
	 * Preload the next track for the end-of-track handoff. Idempotent: same
	 * track already in a non-idle state → no-op.
	 *
	 * Two modes:
	 * - Gapless: when the current engine is a buffer engine and gapless is
	 *   enabled, the next buffer engine is scheduled sample-accurately at the
	 *   current engine's end time.
	 * - Warm HTML preload: in every other case a paused, fully loaded
	 *   HTMLAudioEngine is prepared. Real mobile devices routinely refuse a
	 *   fresh load + play() started from a hidden page after `ended` (the
	 *   multi-second load gap releases the audio focus / media session), so
	 *   the next engine must already exist when the current track ends
	 *   (CONTRACTS.md §14: both engine paths must behave the same). The
	 *   buffer engine is forbidden here: without `scheduleAt` it would
	 *   suspend the graph and silence the currently playing track.
	 */
	async preloadNext(trackId: number): Promise<void> {
		const next = this.#next
		if (next.status !== 'idle' && next.trackId === trackId) {
			return
		}

		this.#teardownAndIdleNext()
		const current = this.#current

		// Never pre-schedule the currently-playing track as the gapless "next".
		// play() will reuse existing engine if same track is requested
		if (current.status === 'ready' && current.trackId === trackId) {
			return
		}

		const currentEngine = current.status === 'ready' ? current.engine : null

		const gaplessSource =
			currentEngine instanceof AudioBufferEngine && this.#options.isGaplessEnabled()
				? currentEngine
				: null

		const transition = createStateTransition(trackId)
		this.#next = transition.loading()

		const result = await this.#tryLoadingEngine(trackId, {
			reason: 'preload',
			signal: this.#next.controller.signal,
			mustBeGapless: gaplessSource !== null,
			mustBeHtml: gaplessSource === null,
			scheduleAt: gaplessSource === null ? undefined : () => gaplessSource.endTime,
		})

		if (result.status === 'aborted') {
			return
		}

		if (result.status === 'failed') {
			// Preload failures stay silent: play() falls back to a fresh load.
			this.#next = transition.failed('preload-failed')
			return
		}

		this.#next = transition.ready(result.engine)
	}

	abortNext(): void {
		this.#teardownAndIdleNext()
	}

	pause(): void {
		this.playing = false
		if (this.#current.status === 'ready') {
			this.#current.engine.pause()
		}
	}

	seek(time: number): void {
		// Optimistically update currentTime so UI has no tear
		this.currentTime = time
		this.#teardownAndIdleNext()
		if (this.#current.status === 'ready') {
			this.#current.engine.seek(time)
		}
	}

	abort(): void {
		this.playing = false
		this.duration = 0

		this.#teardownCurrent()
		this.#current = idle()

		this.#teardownAndIdleNext()
	}

	async #canUseBufferEngine(codec: string): Promise<boolean> {
		if (this.#options.isGaplessEnabled()) {
			return await supportsBufferEngine(codec)
		}

		return false
	}

	async #tryLoadingEngine(
		trackId: number,
		options: TryLoadEngineOptions,
	): Promise<EngineLoadResult> {
		const { scheduleAt, mustBeGapless, mustBeHtml, signal } = options

		try {
			const result = await this.#options.trackLoader(trackId, options.reason)
			signal.throwIfAborted()

			if (result.status !== 'loaded') {
				return { status: 'failed', reason: result.status }
			}

			const canUseBufferEngine = !mustBeHtml && (await this.#canUseBufferEngine(result.codec))
			signal.throwIfAborted()

			const engineOptions: AudioEngineOptions = {
				audioGraph: this.#graph,
				blob: result.file,
				signal,
				playbackRate: this.#playbackRate,
				preservePitch: this.#preservePitch,
				duration: result.duration,
				scheduleAt: scheduleAt?.(),
			}

			let engine: AudioEngine
			if (canUseBufferEngine) {
				engine = await createAudioBufferEngine(engineOptions)
			} else if (mustBeGapless) {
				return { status: 'failed', reason: 'error' }
			} else {
				engine = await createHTMLAudioEngine(engineOptions)
			}

			signal.throwIfAborted()

			return { status: 'loaded', engine }
		} catch (error) {
			if (isAbortError(error)) {
				return { status: 'aborted' }
			}

			console.error('[engine error]:', error)

			return { status: 'failed', reason: 'error' }
		}
	}

	setPlaybackRate(rate: number, preservePitch: boolean): void {
		this.#playbackRate = rate
		this.#preservePitch = preservePitch
		this.#teardownAndIdleNext()
		if (this.#current.status === 'ready') {
			this.#current.engine.setPlaybackRate(rate, preservePitch)
		}
	}

	#promoteToCurrent(readyState: EngineStateReady): void {
		const { engine } = readyState
		engine.onEnded = () => this.#options.onTrackEnded()
		engine.onError = () => this.#options.onError('error')
		this.#current = readyState
		this.duration = engine.duration

		if (this.playing) {
			this.#playEngine(engine)
		}
	}

	/**
	 * Starts engine playback, handling rejections (CONTRACTS.md §14): a play
	 * rejected by the browser (e.g. NotAllowedError from a hidden page) must
	 * not surface as an unhandled rejection or leave a false `playing=true`.
	 */
	#playEngine(engine: AudioEngine): void {
		engine.play().catch((error: unknown) => {
			console.error('[audio] engine play failed:', error)

			// Only the still-current engine may clear the flag: a stale
			// rejection from an already replaced engine must not stop the
			// track that is actually playing now.
			if (this.#current.status === 'ready' && this.#current.engine === engine) {
				this.playing = false
			}
		})
	}

	#teardown(transition: Readonly<EngineState>) {
		if (transition.status === 'loading' || transition.status === 'ready') {
			transition.controller.abort()
		}
	}

	#teardownCurrent() {
		this.#teardown(this.#current)
	}

	#teardownAndIdleNext() {
		if (this.#next.status === 'idle') {
			return
		}

		this.#teardown(this.#next)
		this.#next = idle()
	}
}
