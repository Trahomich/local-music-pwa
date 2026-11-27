import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioGraph } from '../audio-graph.svelte.ts'

/**
 * Regression smoke for CONTRACTS.md §14 (screen-off next-track fix).
 * With the screen off the browser may complete `AudioContext.suspend()`
 * after a `resume()` was already requested, or park the context in WebKit's
 * 'interrupted' state. AudioGraph serializes transitions so the context
 * never stays suspended while the UI believes playback continues.
 */

class MockAudioContext {
	state: AudioContextState = 'running'
	currentTime = 0
	destination = {}

	resume = vi.fn(() => {
		this.state = 'running'
		return Promise.resolve()
	})
	suspend = vi.fn(() => {
		this.state = 'suspended'
		return Promise.resolve()
	})
	close = vi.fn(() => {
		this.state = 'closed'
		return Promise.resolve()
	})

	createBiquadFilter = vi.fn(() => ({
		type: 'peaking',
		frequency: { value: 0 },
		Q: { value: 0 },
		gain: { value: 0 },
		connect: vi.fn(),
		disconnect: vi.fn(),
	}))
	createGain = vi.fn(() => ({
		connect: vi.fn(),
		disconnect: vi.fn(),
		gain: { value: 1, setTargetAtTime: vi.fn() },
	}))

	#stateListeners = new Set<() => void>()

	addEventListener(type: string, listener: () => void): void {
		if (type === 'statechange') {
			this.#stateListeners.add(listener)
		}
	}

	removeEventListener(type: string, listener: () => void): void {
		if (type === 'statechange') {
			this.#stateListeners.delete(listener)
		}
	}

	/** Emulates the OS/browser changing the context state on its own. */
	simulateExternalState(state: AudioContextState): void {
		this.state = state
		for (const listener of this.#stateListeners) {
			listener()
		}
	}
}

let mockContext!: MockAudioContext

beforeEach(() => {
	vi.stubGlobal(
		'AudioContext',
		class extends MockAudioContext {
			constructor() {
				super()
				mockContext = this
			}
		},
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	vi.clearAllMocks()
})

const makeGraph = () => {
	const graph = new AudioGraph()
	// Force the lazy graph creation so the test can drive the context state.
	void graph.context
	return graph
}

describe('AudioGraph state transitions (CONTRACTS.md §14)', () => {
	it('resume issued while a suspend is still in flight ends with a running context', async () => {
		const graph = makeGraph()

		// Screen-off timing: the browser completes suspend() late.
		let finishSuspend!: () => void
		const suspendInFlight = new Promise<void>((resolve) => {
			finishSuspend = () => {
				mockContext.state = 'suspended'
				resolve()
			}
		})
		mockContext.suspend.mockReturnValue(suspendInFlight)

		const suspended = graph.suspend()
		// Let the suspend transition actually start (state still 'running').
		await Promise.resolve()
		expect(mockContext.suspend).toHaveBeenCalledTimes(1)
		expect(mockContext.state).toBe('running')

		// resume() is requested while the suspend has not completed yet —
		// the exact race that used to leave the context suspended forever.
		const resumed = graph.resume()
		finishSuspend()
		await Promise.all([suspended, resumed])

		expect(mockContext.resume).toHaveBeenCalledTimes(1)
		expect(mockContext.state).toBe('running')
	})

	it('resumes the WebKit interrupted state entered when the screen turns off', async () => {
		const graph = makeGraph()
		mockContext.state = 'interrupted' as AudioContextState

		await graph.resume()

		expect(mockContext.resume).toHaveBeenCalledTimes(1)
		expect(mockContext.state).toBe('running')
	})

	it('a failing resume is logged without rejecting and does not poison the queue', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const graph = makeGraph()
		mockContext.state = 'suspended'
		mockContext.resume.mockRejectedValueOnce(
			new DOMException('resume() failed', 'InvalidStateError'),
		)

		await expect(graph.resume()).resolves.toBeUndefined()
		expect(errorSpy).toHaveBeenCalledOnce()
		expect(mockContext.state).toBe('suspended')

		// The next transition still runs and succeeds.
		await graph.resume()
		expect(mockContext.resume).toHaveBeenCalledTimes(2)
		expect(mockContext.state).toBe('running')
	})

	it('skips no-op transitions: resume while running, suspend while suspended', async () => {
		const graph = makeGraph()

		await graph.resume()
		expect(mockContext.resume).not.toHaveBeenCalled()

		mockContext.state = 'suspended'
		await graph.suspend()
		expect(mockContext.suspend).not.toHaveBeenCalled()
	})
})

describe('AudioGraph external suspension (screen-off, CONTRACTS.md §14)', () => {
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

	it('auto-resumes an external suspend while playback is allowed', async () => {
		const graph = makeGraph()
		// User started playback (state already 'running' → no-op transition).
		await graph.resume()

		// Screen-off: the OS suspends the context on its own.
		mockContext.simulateExternalState('suspended')
		await flush()

		expect(mockContext.resume).toHaveBeenCalledTimes(1)
		expect(mockContext.state).toBe('running')
	})

	it('auto-resumes the WebKit interrupted state entered on screen-off', async () => {
		const graph = makeGraph()
		await graph.resume()

		mockContext.simulateExternalState('interrupted' as AudioContextState)
		await flush()

		expect(mockContext.resume).toHaveBeenCalledTimes(1)
		expect(mockContext.state).toBe('running')
	})

	it('does not auto-resume after an explicit suspend (user paused)', async () => {
		const graph = makeGraph()
		await graph.suspend()
		expect(mockContext.state).toBe('suspended')

		mockContext.simulateExternalState('suspended')
		await flush()

		expect(mockContext.resume).not.toHaveBeenCalled()
	})

	it('notifies onInterruptionFailed once when the browser refuses to resume', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const graph = makeGraph()
		const onInterruptionFailed = vi.fn()
		graph.onInterruptionFailed = onInterruptionFailed
		await graph.resume()
		mockContext.resume.mockImplementation(() =>
			Promise.reject(new DOMException('user gesture required', 'NotAllowedError')),
		)

		mockContext.simulateExternalState('suspended')
		await flush()

		expect(onInterruptionFailed).toHaveBeenCalledOnce()
		expect(mockContext.state).toBe('suspended')

		// Playback intent is cleared: further suspends don't spam resume.
		mockContext.simulateExternalState('suspended')
		await flush()
		expect(mockContext.resume).toHaveBeenCalledTimes(1)
		expect(onInterruptionFailed).toHaveBeenCalledOnce()
	})

	it('treats a resume that leaves the context suspended as a failure', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const graph = makeGraph()
		const onInterruptionFailed = vi.fn()
		graph.onInterruptionFailed = onInterruptionFailed
		await graph.resume()
		// Resolves without actually resuming (state stays 'suspended').
		mockContext.resume.mockImplementation(() => Promise.resolve())

		mockContext.simulateExternalState('suspended')
		await flush()

		expect(onInterruptionFailed).toHaveBeenCalledOnce()
	})

	it('stops watching after dispose', async () => {
		const graph = makeGraph()
		await graph.resume()

		graph.dispose()
		mockContext.simulateExternalState('suspended')
		await flush()

		expect(mockContext.resume).not.toHaveBeenCalled()
	})
})
