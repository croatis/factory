import { useInitialData, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import { useTriagePipeline } from '../src/triage/agents/pipeline-core.ts';
import { triagePipelineInputSchema } from '../src/triage/pipeline-contracts.ts';
import { runtimeEnvironment } from './environment.ts';

const inputSchema = v.object({
	...triagePipelineInputSchema.entries,
	workspace: v.string(),
	evidence: v.string(),
	allowSubmodulePublication: v.boolean(),
});

/** The same Factory pipeline, using the prepared Actions workspace. */
export function ActionsTriagePipeline() {
	const input = useInitialData<v.InferOutput<typeof inputSchema>>();
	useSandbox(local({ cwd: input.workspace, env: runtimeEnvironment() }), {
		cwd: input.workspace,
	});
	return useTriagePipeline(input, {
		repository: input.workspace,
		evidence: input.evidence,
		allowSubmodulePublication: input.allowSubmodulePublication,
	});
}
ActionsTriagePipeline.initialData = inputSchema;
ActionsTriagePipeline.durability = {
	maxAttempts: 1,
	timeoutMs: 110 * 60 * 1000,
};
