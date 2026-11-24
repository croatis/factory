import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ActionsTriagePipeline } from './agent.ts';
import { startRuntime, submit } from './runtime.ts';
import { reproduceResultSchema } from '../src/triage/pipeline-contracts.ts';
import { ACTIONS_MODEL } from './config.ts';

/** Live release gate: direct OpenAI, local tools, workspace access, and a Factory submission. */
export async function proveRuntime(workspace: string, signal: AbortSignal) {
	const evidence = resolve(workspace, '.triagebot/factory-proof');
	await mkdir(evidence, { recursive: true });
	const nonce = randomUUID();
	const inputPath = resolve(evidence, 'input.txt');
	const outputPath = resolve(evidence, 'output.txt');
	await writeFile(inputPath, nonce);
	const runtime = await startRuntime();
	try {
		const result = await submit(
			ActionsTriagePipeline,
			`proof:${nonce}`,
			{
				sandboxId: nonce,
				owner: 'factory',
				repo: 'runtime-proof',
				issueNumber: 1,
				issueTitle: 'Node runtime proof',
				issueBody: 'This is a runtime proof, not an application bug.',
				issueAuthor: 'maintainer',
				issueAuthorAssociation: 'OWNER',
				conversation: [],
				defaultBranch: 'master',
				fixBranch: 'triagebot/fix-1',
				skillName: 'triage',
				skillDirectory: resolve(workspace, '.agents/skills/triage'),
				model: ACTIONS_MODEL,
				thinkingLevel: 'low',
				stage: 'reproduce',
				workspace,
				evidence,
				allowSubmodulePublication: false,
			},
			`Runtime proof only. Do not triage the app or follow the triage skill. Use the local shell or filesystem tools to read ${inputPath} and copy its exact content into ${outputPath}. Do not modify any other file. Then call submit_reproduce_result with reproducible=true, skipped=false, skippedReason=null.`,
			'reproduce',
			reproduceResultSchema,
			signal,
		);
		const output = await readFile(outputPath, 'utf8');
		// Text-file tools can append a final newline; the unpredictable nonce must survive unchanged.
		if (!result.reproducible || output.trimEnd() !== nonce) {
			await writeFile(
				resolve(evidence, 'result.json'),
				JSON.stringify(
					{
						passed: false,
						submission: result,
						outputLength: output.length,
						nonceMatches: output.trimEnd() === nonce,
					},
					null,
					2,
				),
			);
			throw new Error('Local workspace proof failed. Inspect result.json.');
		}
		const proof = {
			node: process.version,
			model: ACTIONS_MODEL,
			provider: 'openai',
			listener: false,
			workspaceAccess: true,
			structuredSubmission: true,
			completedAt: new Date().toISOString(),
		};
		await writeFile(
			resolve(evidence, 'result.json'),
			JSON.stringify(proof, null, 2),
		);
		return proof;
	} finally {
		await runtime.stop();
	}
}
