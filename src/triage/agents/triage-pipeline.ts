'use agent';
import { env } from 'cloudflare:workers';
import { useInitialData, useSandbox } from '@flue/runtime';
import type { WorkerEnv } from '../../env.ts';
import {
	type TriagePipelineInput,
	triagePipelineInputSchema,
} from '../pipeline-contracts.ts';
import {
	getTriageSandbox,
	REPO_DIR,
	TRIAGE_DIR,
	triageAgentSandbox,
} from '../sandbox.ts';
import { useTriagePipeline } from './pipeline-core.ts';

/** Cloudflare adapter for the shared Factory pipeline. */
export function TriagePipeline() {
	const input = useInitialData<TriagePipelineInput>();
	useSandbox(
		triageAgentSandbox(
			getTriageSandbox(env as unknown as WorkerEnv, input.sandboxId),
		),
		{ cwd: REPO_DIR },
	);
	return useTriagePipeline(input, {
		repository: REPO_DIR,
		evidence: `${TRIAGE_DIR}/gh-${input.issueNumber}`,
	});
}
TriagePipeline.initialData = triagePipelineInputSchema;
TriagePipeline.durability = { maxAttempts: 10, timeoutMs: 45 * 60 * 1000 };
