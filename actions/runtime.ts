import { init, type Agent } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import * as v from 'valibot';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ActionsTriagePipeline } from './agent.ts';
import { RetriageJudge } from '../src/triage/agents/retriage-judge.ts';
import { FixVerifier } from '../src/triage/agents/fix-verifier.ts';

/** Boot only Triage agents and the direct OpenAI provider, without an HTTP server. */
export async function startRuntime(evidenceDirectory?: string) {
	const provider = openaiProvider();
	let usageWrites = Promise.resolve();
	const observed = new WeakSet<object>();
	function observeUsage<T extends ReturnType<typeof provider.stream>>(
		response: T,
	): T {
		if (observed.has(response)) return response;
		observed.add(response);
		void response
			.result()
			.then((message) => {
				const record = {
					model: message.model,
					provider: message.provider,
					usage: message.usage,
					stopReason: message.stopReason,
					completedAt: new Date().toISOString(),
				};
				// Numeric usage only: never retain prompts, tool arguments, or model response bodies.
				console.log(`Factory model usage: ${JSON.stringify(record)}`);
				if (evidenceDirectory)
					usageWrites = usageWrites
						.then(() =>
							appendFile(
								resolve(evidenceDirectory, 'model-usage.jsonl'),
								JSON.stringify(record) + '\n',
							),
						)
						.catch(() => {
							console.error('Could not persist Factory model usage.');
						});
			})
			.catch(() => {});
		return response;
	}
	// The fetch retry shim is the single owner of model retries, including compaction.
	const stream = provider.stream.bind(provider);
	const streamSimple = provider.streamSimple.bind(provider);
	provider.stream = (model, context, options) =>
		observeUsage(
			stream(model, context, { ...options, maxRetries: 0 } as typeof options),
		);
	provider.streamSimple = (model, context, options) =>
		observeUsage(streamSimple(model, context, { ...options, maxRetries: 0 }));
	RetriageJudge.durability = { ...RetriageJudge.durability, maxAttempts: 1 };
	FixVerifier.durability = { ...FixVerifier.durability, maxAttempts: 1 };
	const runtime = await start({
		agents: [ActionsTriagePipeline, RetriageJudge, FixVerifier],
		providers: [provider],
	});
	return {
		stop: async () => {
			await runtime.stop();
			await usageWrites;
		},
	};
}

export function extractSubmission<S extends v.GenericSchema>(
	data: Record<string, unknown[]>,
	channel: string,
	schema: S,
): v.InferOutput<S> {
	if (data[channel]?.length !== 1)
		throw new Error(`Expected exactly one structured ${channel} submission.`);
	return v.parse(schema, data[channel][0]);
}

/** Separate conversations isolate stages; only compact findings and disk evidence cross stages. */
export async function submit<S extends v.GenericSchema>(
	agent: Agent,
	id: string,
	input: unknown,
	prompt: string,
	channel: string,
	schema: S,
	signal: AbortSignal,
): Promise<v.InferOutput<S>> {
	signal.throwIfAborted();
	const handle = init(agent, { id });
	const receipt = await handle.dispatch({
		message: prompt,
		initialData: input,
		idempotencyKey: id,
	});
	const abort = () => {
		void handle.abort().catch(() => {});
	};
	signal.addEventListener('abort', abort, { once: true });
	try {
		signal.throwIfAborted();
		const reply = await handle.read(receipt, { signal });
		return extractSubmission(reply.data, channel, schema);
	} finally {
		signal.removeEventListener('abort', abort);
		if (signal.aborted) await handle.abort();
	}
}
