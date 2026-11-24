import { init, type Agent } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import * as v from 'valibot';
import { ActionsTriagePipeline } from './agent.ts';
import { RetriageJudge } from '../src/triage/agents/retriage-judge.ts';
import { FixVerifier } from '../src/triage/agents/fix-verifier.ts';

/** Boot only Triage agents and the direct OpenAI provider, without an HTTP server. */
export async function startRuntime() {
	const provider = openaiProvider();
	// The fetch retry shim is the single owner of model retries, including compaction.
	const stream = provider.stream.bind(provider);
	const streamSimple = provider.streamSimple.bind(provider);
	provider.stream = (model, context, options) =>
		stream(model, context, { ...options, maxRetries: 0 } as typeof options);
	provider.streamSimple = (model, context, options) =>
		streamSimple(model, context, { ...options, maxRetries: 0 });
	RetriageJudge.durability = { ...RetriageJudge.durability, maxAttempts: 1 };
	FixVerifier.durability = { ...FixVerifier.durability, maxAttempts: 1 };
	return start({
		agents: [ActionsTriagePipeline, RetriageJudge, FixVerifier],
		providers: [provider],
	});
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
