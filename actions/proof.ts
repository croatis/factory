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
	const skillDirectory = resolve(evidence, 'skill');
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(
		resolve(skillDirectory, 'SKILL.md'),
		`# Runtime proof\nThis stage checks local file access only. It does not test the application.\nRead ${inputPath} with a local tool. Copy its exact contents to ${outputPath} with a local tool. Read back the output to verify it. Do not modify source files or start the application. Then submit reproducible=true, skipped=false, skippedReason=null.\n`,
	);
	const runtime = await startRuntime(evidence);
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
				skillName: 'runtime-proof',
				skillDirectory,
				model: ACTIONS_MODEL,
				thinkingLevel: 'low',
				stage: 'reproduce',
				workspace,
				evidence,
				allowSubmodulePublication: false,
			},
			`Follow ${skillDirectory}/SKILL.md to complete the local file-access proof, then call submit_reproduce_result exactly once.`,
			'reproduce',
			reproduceResultSchema,
			signal,
		);
		const output = await readFile(outputPath, 'utf8').catch(() => null);
		// Text-file tools can append a final newline; the unpredictable nonce must survive unchanged.
		if (!result.reproducible || output?.trimEnd() !== nonce) {
			await writeFile(
				resolve(evidence, 'result.json'),
				JSON.stringify(
					{
						passed: false,
						submission: result,
						outputLength: output?.length ?? null,
						nonceMatches: output?.trimEnd() === nonce,
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
