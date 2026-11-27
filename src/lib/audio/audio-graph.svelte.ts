import { EQ_BANDS } from './eq-bands.ts'

/**
 * Owns the AudioContext and the EQ filter chain.
 * Multiple engines connect their GainNodes to `inputNode`.
 *
 *   engineA.gainNode ─┐
 *                      ├─→ inputNode → filter[0] → … → filter[9] → destination
 *   engineB.gainNode ─┘
 */
export class AudioGraph {
	#context: AudioContext | null = $state(null)
	#inputNode: GainNode | null = null
	#volumeNode: GainNode | null = null
	#filters: BiquadFilterNode[] = []

	/**
	 * Serializes suspend/resume transitions (CONTRACTS.md §14). Without it a
	 * resume issued while a suspend is still in flight observed the stale
	 * 'running' state, skipped the actual `context.resume()` and left the
	 * context suspended forever — frozen `currentTime`, no `ended`, a dead
	 * queue with a false `playing=true` (typical for screen-off timing).
	 */
	#transitionQueue: Promise<unknown> = Promise.resolve()

	/**
	 * Whether playback was requested through `resume()` and not suspended
	 * since. While set, a suspension the graph did not ask for (OS screen-off,
	 * audio-focus loss) is rolled back instead of silently stopping playback.
	 */
	#wantRunning = false

	/**
	 * Called when the context was suspended externally and could not be
	 * resumed (the browser demands a fresh user gesture): playback cannot
	 * continue, so the UI must not keep a false `playing=true`.
	 */
	onInterruptionFailed: (() => void) | null = null

	/**
	 * Lazily creates the AudioContext on first access.
	 * Must be called from a user-gesture handler on first use.
	 */
	get context(): AudioContext {
		return this.#ensureGraph()
	}

	get initialized(): boolean {
		return this.#context !== null
	}

	get inputNode(): GainNode {
		this.#ensureGraph()
		invariant(this.#inputNode, 'AudioGraph input node should be initialized')

		return this.#inputNode
	}

	/**
	 * The EQ filter nodes, exposed for EqualizerStore to control gain.
	 * Indices correspond 1:1 with EQ_BANDS.
	 */
	get filters(): readonly BiquadFilterNode[] {
		this.#ensureGraph()
		return this.#filters
	}

	#ensureGraph(): AudioContext {
		if (this.#context) {
			return this.#context
		}

		const ctx = new AudioContext()

		const filters = EQ_BANDS.map(({ frequency }) => {
			const filter = ctx.createBiquadFilter()
			filter.type = 'peaking'
			filter.frequency.value = frequency
			filter.Q.value = 1.41
			filter.gain.value = 0
			return filter
		})

		// A GainNode as the mixer/entry point keeps inputNode
		// semantically distinct from the first EQ filter.
		const inputNode = ctx.createGain()

		let node: AudioNode = inputNode
		for (const filter of filters) {
			node.connect(filter)
			node = filter
		}
		const volumeNode = ctx.createGain()
		node.connect(volumeNode)
		volumeNode.connect(ctx.destination)
		ctx.addEventListener('statechange', this.#onContextStateChange)

		this.#context = ctx
		this.#inputNode = inputNode
		this.#volumeNode = volumeNode
		this.#filters = filters

		return ctx
	}

	setVolume(normalized: number): void {
		if (this.#volumeNode && this.#context) {
			this.#volumeNode.gain.setTargetAtTime(normalized, this.#context.currentTime, 0.015)
		}
	}

	/**
	 * Queues a context state transition so suspend/resume never interleave.
	 * Never rejects: these are fire-and-forget control operations and every
	 * caller `void`s them; failures are logged instead of becoming unhandled
	 * rejections.
	 */
	#enqueueTransition(operation: () => Promise<void>): Promise<void> {
		const result = this.#transitionQueue.then(operation)
		const settled = result.catch((error: unknown) => {
			console.error('[audio] context state transition failed:', error)
		})
		this.#transitionQueue = settled

		return settled
	}

	/**
	 * Resumes the context unless it is already running. Compares against
	 * 'running' (not 'suspended') so WebKit's 'interrupted' state — entered on
	 * mobile when the screen turns off — is resumed too. Never rejects.
	 */
	resume(): Promise<void> {
		this.#wantRunning = true
		return this.#enqueueTransition(async () => {
			if (this.#context && this.#context.state !== 'running') {
				await this.#context.resume()
			}
		})
	}

	/** Suspends the context when it is running. Never rejects. */
	suspend(): Promise<void> {
		this.#wantRunning = false
		return this.#enqueueTransition(async () => {
			if (this.#context && this.#context.state === 'running') {
				await this.#context.suspend()
			}
		})
	}

	/**
	 * Rolls back external suspensions (CONTRACTS.md §14): with the screen off
	 * the OS/browser may suspend the context on its own, and no play or
	 * buffering event follows — `currentTime` freezes, `ended` never fires and
	 * the queue dies with a false `playing=true`. A suspension is external
	 * when `#wantRunning` is set: our own suspensions clear it first.
	 */
	#onContextStateChange = (): void => {
		const ctx = this.#context
		if (!(ctx && this.#wantRunning)) {
			return
		}
		if (ctx.state === 'running') {
			return
		}

		void this.#enqueueTransition(async () => {
			if (this.#context !== ctx || ctx.state === 'running') {
				return
			}

			try {
				await ctx.resume()
			} catch (error) {
				this.#failInterruption(error)
				return
			}

			// Re-read through an assertion: resume() mutates the state, which
			// TS's narrowing from the guard above cannot see.
			if (this.#context === ctx && (ctx.state as AudioContextState) !== 'running') {
				this.#failInterruption(
					new Error(`AudioContext still '${ctx.state}' after resume()`),
				)
			}
		})
	}

	#failInterruption(error: unknown): void {
		console.error('[audio] cannot resume after external suspension:', error)
		this.#wantRunning = false
		this.onInterruptionFailed?.()
	}

	dispose(): void {
		if (this.#context) {
			this.#context.removeEventListener('statechange', this.#onContextStateChange)
			this.#context.close()
		}
		this.#context = null
		this.#wantRunning = false
		this.#inputNode = null
		this.#volumeNode = null
		this.#filters = []
	}
}
