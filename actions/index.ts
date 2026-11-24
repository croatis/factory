import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runActions } from './runner.ts';
import { proveRuntime } from './proof.ts';
import retry from './retry.cjs';

const controller = new AbortController();
const deadline = Number(
	process.env.FACTORY_DEADLINE_MS || Date.now() + 110 * 60 * 1000,
);
if (!Number.isFinite(deadline) || deadline <= Date.now())
	throw new Error('The Actions job budget is exhausted.');
const timeout = setTimeout(
	() => controller.abort(new Error('Factory job budget exhausted.')),
	Math.min(deadline - Date.now(), 110 * 60 * 1000),
);
const cancel = () => controller.abort(new Error('Factory was cancelled.'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const originalFetch = globalThis.fetch;
globalThis.fetch = retry.createRetryingFetch(originalFetch, {
	deadline,
	signal: controller.signal,
});

try {
	if (!['triage', 'proof'].includes(process.env.FACTORY_MODE || 'triage'))
		throw new Error('Factory mode must be triage or proof.');
	const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
	const outcome =
		process.env.FACTORY_MODE === 'proof'
			? await proveRuntime(workspace, controller.signal)
			: await runActions({
					eventName:
						process.env.FACTORY_EVENT_NAME || process.env.GITHUB_EVENT_NAME!,
					event: JSON.parse(
						await readFile(
							process.env.FACTORY_EVENT_PATH || process.env.GITHUB_EVENT_PATH!,
							'utf8',
						),
					),
					repository: process.env.GITHUB_REPOSITORY!,
					workspace,
					credentials: {
						readToken: process.env.FACTORY_READ_TOKEN,
						writeToken: process.env.FACTORY_WRITE_TOKEN,
						appId: process.env.FACTORY_APP_ID,
						privateKey: process.env.FACTORY_APP_PRIVATE_KEY,
					},
					botLogins: process.env.FACTORY_BOT_LOGINS,
					evidenceDirectory:
						process.env.FACTORY_EVIDENCE_DIRECTORY || undefined,
					requiredRuntimeState:
						process.env.FACTORY_REQUIRED_RUNTIME_STATE || undefined,
					allowSubmodulePublication:
						process.env.FACTORY_ALLOW_SUBMODULE_PUBLICATION === 'true',
					signal: controller.signal,
				});
	console.log(JSON.stringify(outcome));
	if (process.env.GITHUB_OUTPUT)
		await appendFile(
			process.env.GITHUB_OUTPUT,
			`result=${JSON.stringify(outcome)}\n`,
		);
} catch (error) {
	// Redact exact credential values before recording runtime errors in the restricted Actions log.
	let message =
		error instanceof Error
			? `${error.message}${error.cause ? `\n${String(error.cause)}` : ''}`
			: String(error);
	for (const name of [
		'OPENAI_API_KEY',
		'FACTORY_READ_TOKEN',
		'FACTORY_WRITE_TOKEN',
		'FACTORY_APP_PRIVATE_KEY',
	]) {
		const value = process.env[name];
		if (value) message = message.replaceAll(value, '[redacted]');
	}
	console.error(message);
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	process.removeListener('SIGINT', cancel);
	process.removeListener('SIGTERM', cancel);
	globalThis.fetch = originalFetch;
}
