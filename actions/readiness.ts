import { readFile } from 'node:fs/promises';
import { containedPath } from './workspace.ts';

export class RuntimeNotReady extends Error {
	constructor() {
		super('Required application startup and provisioning did not complete.');
	}
}

/** Keep failed startup from becoming a verified reproduction or published fix. */
export async function requireRuntimeReady(
	workspace: string,
	statePath?: string,
) {
	if (!statePath) return;
	try {
		const path = await containedPath(workspace, statePath);
		const state = JSON.parse(await readFile(path, 'utf8'));
		if (state.status === 'ready' && state.provisioned === true) return;
	} catch {
		// Missing, malformed, or out-of-workspace evidence fails closed.
	}
	throw new RuntimeNotReady();
}
