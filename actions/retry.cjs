// Retry rejected model requests before Flue sees an error, keeping its session alive.
// Loaded through NODE_OPTIONS by the prebuilt triage action. No SDK dependency needed.
const { setTimeout: sleep } = require('node:timers/promises');

function serverDelayMs(response, error, now) {
	const milliseconds = response.headers.get('retry-after-ms');
	if (
		milliseconds?.trim() &&
		Number.isFinite(Number(milliseconds)) &&
		Number(milliseconds) >= 0
	) {
		return Number(milliseconds);
	}

	const retryAfter = response.headers.get('retry-after');
	if (retryAfter?.trim()) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		if (!Number.isFinite(seconds)) {
			const date = Date.parse(retryAfter);
			if (Number.isFinite(date)) return Math.max(0, date - now());
		}
	}

	// Some providers include a delay only in the error text, as in the reported failure.
	const match = /please try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(
		error.message ?? '',
	);
	if (match)
		return Number(match[1]) * (match[2].toLowerCase() === 'ms' ? 1 : 1000);
	return undefined;
}

async function waitForRetry(milliseconds, signal) {
	// Chunk long server delays to avoid Node's timer overflow and retain cancellation.
	const deadline = Date.now() + milliseconds;
	let remaining = milliseconds;
	while (remaining > 0) {
		signal?.throwIfAborted();
		await sleep(Math.min(remaining, 60_000), undefined, { signal });
		remaining = deadline - Date.now();
	}
}

/**
 * @param {typeof globalThis.fetch} fetch
 * @param {{wait?: (ms: number, signal?: AbortSignal) => Promise<void>, random?: () => number,
 * now?: () => number, log?: (message: string) => void, deadline?: number, signal?: AbortSignal}} [options]
 */
function createRetryingFetch(
	fetch,
	{
		wait = waitForRetry,
		random = Math.random,
		now = Date.now,
		log = console.info,
		deadline = Date.now() + 110 * 60 * 1000,
		signal,
	} = {},
) {
	return async function retryingFetch(input, init) {
		// The pinned OpenAI SDK sends JSON strings. Never replay streaming/one-shot bodies
		// or intercept GitHub, application, uploads, and unrelated provider requests.
		if (
			!(typeof input === 'string' || input instanceof URL) ||
			init?.method?.toUpperCase() !== 'POST' ||
			typeof init.body !== 'string'
		) {
			return fetch(input, init);
		}
		const url = new URL(input);
		if (
			url.origin !== 'https://api.openai.com' ||
			!['/v1/responses', '/v1/chat/completions'].includes(url.pathname)
		) {
			return fetch(input, init);
		}

		if (signal)
			init = {
				...init,
				signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
			};

		for (let attempt = 0; ; attempt++) {
			init.signal?.throwIfAborted();
			const response = await fetch(input, init);
			// Successful streams pass through untouched, including any later stream errors.
			if (response.status !== 429) return response;

			let error;
			try {
				error = (await response.clone().json()).error;
			} catch {
				return response;
			}
			// Quota/billing failures and unknown 429s need intervention, not an endless wait.
			const code = error?.code;
			if (error?.type !== 'rate_limit_error' && code !== 'rate_limit_exceeded')
				return response;
			if (code && !['rate_limit_exceeded', 'slow_down'].includes(code))
				return response;

			const serverDelay = serverDelayMs(response, error, now);
			const fallbackDelay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
			const delay =
				Math.max(1000, serverDelay ?? fallbackDelay) +
				250 +
				Math.floor(random() * 750);
			if (!Number.isFinite(delay)) return response;
			if (now() + delay >= deadline)
				throw new Error('OpenAI retry would exceed the Actions job budget.');
			await response.body?.cancel();
			log(
				`[triage:rate-limit] Waiting ${(delay / 1000).toFixed(3)}s before retry ${attempt + 1}; preserving the active session.`,
			);
			await wait(delay, init.signal);
		}
	};
}

module.exports = { createRetryingFetch };
