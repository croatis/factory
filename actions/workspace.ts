import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const execute = promisify(execFile);

/** Scope a parent credential to one Git process, without changing checkout/submodule credentials. */
export function githubGitEnvironment(token: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: '0',
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
		GIT_CONFIG_VALUE_0: '',
		GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
		GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
	};
}

export async function git(
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	try {
		return (
			await execute('git', args, {
				cwd,
				env,
				timeout: 120000,
				maxBuffer: 16 * 1024 * 1024,
			})
		).stdout.trimEnd();
	} catch {
		// Git may echo credential-bearing URLs/headers. Keep raw failures out of public reports.
		throw new Error(
			`Git ${args[0]} failed in ${cwd}. Check repository access and branch state.`,
		);
	}
}

export function assertPublicationBranch(branch: string, defaultBranch: string) {
	if (
		[
			defaultBranch,
			'main',
			'master',
			`origin/${defaultBranch}`,
			'origin/main',
			'origin/master',
		].includes(branch) ||
		!/^(triagebot|flue|factory)\/fix-\d+$/.test(branch)
	) {
		throw new Error(`Refusing publication to branch ${branch}.`);
	}
}

export async function containedPath(root: string, path: string) {
	const resolved = await realpath(resolve(root, path));
	const rel = relative(await realpath(root), resolved);
	if (rel.startsWith('..') || isAbsolute(rel))
		throw new Error('Path must stay within the prepared workspace.');
	return resolved;
}

/** Use a legacy branch when present, without resetting any remote or local work. */
export async function prepareWorkspace(
	workspace: string,
	branch: string,
	defaultBranch: string,
	existing: boolean,
	token?: string,
) {
	assertPublicationBranch(branch, defaultBranch);
	const root = await realpath(workspace);
	if (
		(await realpath(await git(root, ['rev-parse', '--show-toplevel']))) !== root
	)
		throw new Error('Workspace must be the Git root.');
	const dirty = await git(root, [
		'status',
		'--porcelain',
		'--ignore-submodules=all',
	]);
	if (dirty)
		throw new Error(
			'The prepared superproject has existing source changes. Refusing to overwrite them.',
		);
	const fetchEnvironment = token ? githubGitEnvironment(token) : process.env;
	await git(
		root,
		[
			'fetch',
			'--no-tags',
			'origin',
			`refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
		],
		fetchEnvironment,
	);
	if (existing) {
		await git(
			root,
			[
				'fetch',
				'--no-tags',
				'origin',
				`refs/heads/${branch}:refs/remotes/origin/${branch}`,
			],
			fetchEnvironment,
		);
		await git(root, [
			'checkout',
			'-b',
			branch,
			`refs/remotes/origin/${branch}`,
		]);
		// Reopened issues whose former fix was merged should investigate the current default.
		const head = await git(root, ['rev-parse', 'HEAD']);
		if (
			(await git(root, [
				'merge-base',
				'HEAD',
				`refs/remotes/origin/${defaultBranch}`,
			])) === head
		) {
			await git(root, [
				'merge',
				'--ff-only',
				`refs/remotes/origin/${defaultBranch}`,
			]);
		}
		await git(root, ['submodule', 'update', '--init', '--recursive']);
	} else {
		await git(root, ['checkout', '-b', branch]);
	}
	return {
		head: await git(root, ['rev-parse', 'HEAD']),
		origin: await git(root, ['remote', 'get-url', 'origin']),
	};
}

/** Verify every retained gitlink against freshly fetched remote branches, recursively. */
export async function verifySubmodulePublication(
	workspace: string,
): Promise<Array<{ path: string; sha: string }>> {
	const published: Array<{ path: string; sha: string }> = [];
	async function verify(directory: string) {
		const entries = (await git(directory, ['ls-files', '--stage', '-z'])).split(
			'\0',
		);
		for (const entry of entries) {
			const match = /^160000 ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(entry);
			if (!match) continue;
			const [, sha, path] = match;
			const module = await containedPath(directory, path);
			if ((await git(module, ['rev-parse', 'HEAD'])) !== sha)
				throw new Error(
					`Submodule pointer does not match its checkout: ${path}.`,
				);
			if (await git(module, ['status', '--porcelain']))
				throw new Error(`Submodule contains unpublished changes: ${path}.`);
			// A private verification namespace prevents stale origin refs from proving reachability.
			await git(module, [
				'fetch',
				'--no-tags',
				'--prune',
				'origin',
				'+refs/heads/*:refs/factory-publication/*',
			]);
			const reachable = await git(module, [
				'for-each-ref',
				`--contains=${sha}`,
				'--format=%(refname)',
				'refs/factory-publication/',
			]);
			if (!reachable)
				throw new Error(
					`Submodule commit is not reachable from a remote branch: ${path} ${sha}.`,
				);
			published.push({ path: relative(workspace, module), sha });
			await verify(module);
		}
	}
	await verify(workspace);
	return published;
}

export async function publishWorkspace(options: {
	workspace: string;
	branch: string;
	defaultBranch: string;
	expectedHead: string;
	expectedOrigin: string;
	message: string;
	token: string;
	repository: string;
}) {
	const {
		workspace,
		branch,
		defaultBranch,
		expectedHead,
		expectedOrigin,
		message,
		token,
		repository,
	} = options;
	assertPublicationBranch(branch, defaultBranch);
	if (
		(await git(workspace, ['branch', '--show-current'])) !== branch ||
		(await git(workspace, ['rev-parse', 'HEAD'])) !== expectedHead
	) {
		throw new Error(
			'The agent changed the superproject branch or committed it. Publication stopped.',
		);
	}
	if (
		(await git(workspace, ['remote', 'get-url', 'origin'])) !== expectedOrigin
	)
		throw new Error('The superproject origin changed.');
	const canonical = `https://github.com/${repository}.git`;
	if (![canonical, canonical.slice(0, -4)].includes(expectedOrigin))
		throw new Error('The origin does not match the target GitHub repository.');
	await git(workspace, ['add', '--all']);
	const submodules = await verifySubmodulePublication(workspace);
	if (await git(workspace, ['diff', '--cached', '--name-only'])) {
		await git(workspace, [
			'-c',
			'core.hooksPath=/dev/null',
			'commit',
			'-m',
			message,
		]);
	}
	const sha = await git(workspace, ['rev-parse', 'HEAD']);
	const base = await git(workspace, [
		'rev-parse',
		`refs/remotes/origin/${defaultBranch}`,
	]);
	if (!(await git(workspace, ['diff', '--name-only', `${base}...${sha}`])))
		throw new Error(
			'The verified fix has no changes relative to the default branch.',
		);
	// Reset inherited checkout headers only for this operation. Submodule credentials remain separate.
	const env = githubGitEnvironment(token);
	await git(workspace, ['push', 'origin', `HEAD:refs/heads/${branch}`], env);
	const remote = await git(
		workspace,
		['ls-remote', 'origin', `refs/heads/${branch}`],
		env,
	);
	if (remote.split(/\s+/)[0] !== sha)
		throw new Error('The pushed branch SHA could not be verified.');
	return { sha, submodules };
}
