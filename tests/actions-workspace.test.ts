import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	git,
	verifySubmodulePublication,
	assertPublicationBranch,
	prepareWorkspace,
} from '../actions/workspace.ts';

const directories: string[] = [];
// These cases create real repositories and invoke Git repeatedly, including on Windows runners.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'factory-publication-'));
	directories.push(root);
	const remote = join(root, 'remote.git');
	const source = join(root, 'source');
	const parent = join(root, 'parent');
	for (const path of [remote, source, parent]) await mkdir(path);
	await git(remote, ['init', '--bare']);
	for (const path of [source, parent]) {
		await git(path, ['init', '-b', 'default']);
		await git(path, ['config', 'user.name', 'Factory test']);
		await git(path, ['config', 'user.email', 'factory@example.invalid']);
		await writeFile(join(path, 'file.txt'), 'baseline\n');
		await git(path, ['add', '.']);
		await git(path, ['commit', '-m', 'Baseline']);
	}
	await git(source, ['remote', 'add', 'origin', remote]);
	await git(source, ['push', 'origin', 'default']);
	await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/default']);
	await git(parent, [
		'-c',
		'protocol.file.allow=always',
		'submodule',
		'add',
		remote,
		'Owning Module',
	]);
	await git(parent, ['commit', '-m', 'Add module']);
	const module = join(parent, 'Owning Module');
	await git(module, ['config', 'user.name', 'Factory test']);
	await git(module, ['config', 'user.email', 'factory@example.invalid']);
	await git(module, ['checkout', '-b', 'triagebot/fix-10']);
	return { parent, module, remote, source };
}

it('accepts a reachable retained submodule commit, including paths with spaces', async () => {
	const { parent, module } = await fixture();
	expect(await verifySubmodulePublication(parent)).toEqual([
		{ path: 'Owning Module', sha: await git(module, ['rev-parse', 'HEAD']) },
	]);
});

it('blocks a parent pointer until the submodule commit has been pushed', async () => {
	const { parent, module } = await fixture();
	await writeFile(join(module, 'file.txt'), 'verified fix\n');
	await git(module, ['add', '.']);
	await git(module, ['commit', '-m', 'Fix']);
	await git(parent, ['add', 'Owning Module']);
	await expect(verifySubmodulePublication(parent)).rejects.toThrow(
		/not reachable/,
	);
	await git(module, ['push', 'origin', 'triagebot/fix-10']);
	expect(await verifySubmodulePublication(parent)).toHaveLength(1);
});

it('does not accept a stale tracking ref after its remote branch disappears', async () => {
	const { parent, module, remote } = await fixture();
	await writeFile(join(module, 'file.txt'), 'verified fix\n');
	await git(module, ['add', '.']);
	await git(module, ['commit', '-m', 'Fix']);
	await git(parent, ['add', 'Owning Module']);
	await git(module, ['push', 'origin', 'triagebot/fix-10']);
	await verifySubmodulePublication(parent);
	await git(remote, ['update-ref', '-d', 'refs/heads/triagebot/fix-10']);
	await expect(verifySubmodulePublication(parent)).rejects.toThrow(
		/not reachable/,
	);
});

it('rejects uncommitted submodule files even when its existing SHA was published', async () => {
	const { parent, module } = await fixture();
	await writeFile(join(module, 'uncommitted.txt'), 'fix not committed');
	await expect(verifySubmodulePublication(parent)).rejects.toThrow(
		/unpublished changes/,
	);
});

it('rejects the actual default branch even when it has a fix-like name', () => {
	expect(() =>
		assertPublicationBranch('triagebot/fix-10', 'triagebot/fix-10'),
	).toThrow();
});

it('fast-forwards a previously merged fix branch before investigating a reopened issue', async () => {
	const { source, remote } = await fixture();
	const original = await git(source, ['rev-parse', 'HEAD']);
	await git(source, ['push', 'origin', 'HEAD:refs/heads/triagebot/fix-10']);
	await writeFile(join(source, 'new-default.txt'), 'current default contents');
	await git(source, ['add', '.']);
	await git(source, ['commit', '-m', 'Advance default']);
	await git(source, ['push', 'origin', 'default']);
	const current = await git(source, ['rev-parse', 'HEAD']);
	const workspace = await prepareWorkspace(
		source,
		'triagebot/fix-10',
		'default',
		true,
	);
	expect(workspace.head).toBe(current);
	expect(await git(source, ['branch', '--show-current'])).toBe(
		'triagebot/fix-10',
	);
	expect(await git(remote, ['rev-parse', 'refs/heads/triagebot/fix-10'])).toBe(
		original,
	);
});
