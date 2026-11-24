import * as v from 'valibot';
import {
	reproduceResultSchema,
	diagnoseResultSchema,
	verifyResultSchema,
	fixResultSchema,
	type TriagePipelineResult,
} from '../src/triage/pipeline-contracts.ts';
import {
	reproduceStepPrompt,
	diagnoseStepPrompt,
	verifyStepPrompt,
	fixStepPrompt,
} from '../src/triage/prompts.ts';

export type StageRunner = <S extends v.GenericSchema>(
	stage: string,
	prompt: string,
	schema: S,
) => Promise<v.InferOutput<S>>;

/** Preserve repository early exits while reusing Factory submissions and stage prompts. */
export async function runPipeline(
	run: StageRunner,
	submodules: boolean,
): Promise<TriagePipelineResult> {
	const result: TriagePipelineResult = {
		completedStage: 'reproduce',
		reproducible: false,
		skipped: false,
		skippedReason: null,
		diagnosisConfidence: null,
		verdict: null,
		fixed: false,
		commitMessage: null,
	};
	Object.assign(
		result,
		await run('reproduce', reproduceStepPrompt(), reproduceResultSchema),
	);
	if (result.skipped || !result.reproducible) return result;
	result.diagnosisConfidence = (
		await run('diagnose', diagnoseStepPrompt(), diagnoseResultSchema)
	).confidence;
	if (!['medium', 'high'].includes(result.diagnosisConfidence ?? ''))
		return result;
	result.verdict = (
		await run('verify', verifyStepPrompt(), verifyResultSchema)
	).verdict;
	result.completedStage = 'verify';
	if (result.verdict === 'intended-behavior') return result;
	const prompt = submodules
		? fixStepPrompt({ allowSubmodulePublication: true })
		: fixStepPrompt();
	Object.assign(result, await run('fix', prompt, fixResultSchema));
	result.completedStage = 'fix';
	if (result.fixed && !result.commitMessage?.trim())
		throw new Error('A verified fix must supply a commit message.');
	return result;
}
