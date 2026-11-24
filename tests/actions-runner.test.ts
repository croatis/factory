import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

const mock = vi.hoisted(() => ({
	api: null as any,
	submissions: [] as string[],
	failPublication: false,
	publish: vi.fn(),
	prepare: vi.fn(),
	verifySubmodules: vi.fn(),
	result: 'fixed',
	retriage: true,
}));
vi.mock('../actions/auth.ts', () => ({
	githubClients: async () => ({
		read: mock.api,
		write: async () => mock.api,
		writeToken: async () => 'test-token',
	}),
}));
vi.mock('../actions/workspace.ts', async (original) => ({
	...(await original<any>()),
	prepareWorkspace: (...args: unknown[]) => {
		mock.prepare(...args);
		return { head: 'base-sha', origin: 'https://github.com/owner/repo.git' };
	},
	verifySubmodulePublication: (...args: unknown[]) =>
		mock.verifySubmodules(...args),
	publishWorkspace: async (options: any) => {
		mock.publish(options);
		if (mock.failPublication) throw new Error('Submodule not reachable');
		return { sha: 'published-sha', submodules: [] };
	},
}));
vi.mock('../actions/runtime.ts', () => ({
	startRuntime: async () => ({ stop: async () => {} }),
	submit: async (
		_agent: unknown,
		_id: string,
		_input: unknown,
		_prompt: string,
		channel: string,
		schema: v.GenericSchema,
	) => {
		mock.submissions.push(channel);
		const results: Record<string, unknown> = {
			decision: {
				retriage: mock.retriage,
				reasoning: 'New reproduction details.',
			},
			reproduce: {
				reproducible: mock.result !== 'unreproducible',
				skipped: false,
				skippedReason: null,
			},
			diagnose: { confidence: 'high' },
			verify: { verdict: 'bug', confidence: 'high' },
			fix: { fixed: true, commitMessage: 'Repair behavior' },
			pr: {
				title: 'Repair behavior',
				body: '## Changes\nFix the behavior.\n## Testing\nRegression test.\n## Docs\nNot needed.\nCloses #10',
			},
			verdict: {
				status: 'confirmed',
				reasoning: 'Reporter tested it.',
				pr: {
					title: 'Repair behavior',
					body: '## Changes\nFix.\n## Testing\nTest.\n## Docs\nNone.',
				},
			},
			comment: {
				comment: '- **Reproduced:** Yes\nA verified fix is available.',
			},
			labels: { priority: '- P2', packages: [] },
		};
		return v.parse(schema, results[channel]);
	},
}));
import { runActions, type RunOptions } from '../actions/runner.ts';

let workspace: string;
let labels: string[];
let comments: any[];
let pulls: any[];
let issueState: string;
let options: RunOptions;

beforeEach(async () => {
	mock.submissions = [];
	mock.failPublication = false;
	mock.result = 'fixed';
	mock.retriage = true;
	mock.publish.mockClear();
	mock.prepare.mockClear();
	mock.verifySubmodules.mockClear();
	workspace = await mkdtemp(join(tmpdir(), 'factory-runner-'));
	await mkdir(join(workspace, '.github'));
	await mkdir(join(workspace, '.agents/skills/triage'), { recursive: true });
	await writeFile(
		join(workspace, '.agents/skills/triage/SKILL.md'),
		'# Test skill',
	);
	await writeFile(
		join(workspace, '.github/factory.yml'),
		'version: 1\ntriage:\n  skill: .agents/skills/triage\n  installCommand: []\n  buildCommand: []\n  autoPrOnFix: true\n',
	);
	labels = [];
	comments = [];
	pulls = [];
	issueState = 'open';
	const issue = () => ({
		number: 10,
		state: issueState,
		labels,
		title: 'Broken behavior',
		body: 'Reproduce the bug.',
		user: { login: 'reporter' },
		author_association: 'NONE',
	});
	const api = {
		rest: {
			repos: {
				get: async () => ({ data: { default_branch: 'release' } }),
				getBranch: vi.fn(async () => {
					throw { status: 404 };
				}),
			},
			issues: {
				get: async () => ({ data: issue() }),
				listComments: async () => ({ data: comments }),
				listLabelsForRepo: async () => ({
					data: [{ name: '- P2', description: 'Normal' }],
				}),
				getLabel: async () => ({ data: {} }),
				createLabel: async () => ({ data: {} }),
				addLabels: async ({ labels: next }: any) => {
					labels = [...new Set([...labels, ...next])];
				},
				removeLabel: async ({ name }: any) => {
					labels = labels.filter((l) => l !== name);
				},
				createComment: vi.fn(async ({ body }: any) => {
					const comment = {
						id: comments.length + 1,
						body,
						user: { login: 'factory[bot]', type: 'Bot' },
						author_association: 'NONE',
					};
					comments.push(comment);
					return { data: comment };
				}),
				updateComment: async ({ comment_id, body }: any) => {
					comments.find((c) => c.id === comment_id).body = body;
				},
			},
			pulls: {
				list: async () => ({ data: pulls }),
				create: vi.fn(async (input: any) => {
					const pull = {
						...input,
						number: 20,
						html_url: 'https://github.com/owner/repo/pull/20',
						state: 'open',
						base: { ref: input.base },
						head: { ref: input.head, repo: { full_name: 'owner/repo' } },
					};
					pulls.push(pull);
					return { data: pull };
				}),
			},
		},
		paginate: async (method: any, args: any) => (await method(args)).data,
	};
	mock.api = api;
	options = {
		eventName: 'issues',
		repository: 'owner/repo',
		workspace,
		credentials: {},
		allowSubmodulePublication: true,
		signal: new AbortController().signal,
		event: {
			action: 'opened',
			repository: { full_name: 'owner/repo' },
			issue: { number: 10, updated_at: 'now' },
		},
	};
});
afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

it('publishes one verified fix against the actual default and does not repeat a completed delivery', async () => {
	expect(await runActions(options)).toMatchObject({
		outcome: 'triaged',
		label: 'triage: fix verified',
	});
	expect(mock.publish).toHaveBeenCalledWith(
		expect.objectContaining({
			defaultBranch: 'release',
			branch: 'triagebot/fix-10',
		}),
	);
	expect(mock.api.rest.pulls.create).toHaveBeenCalledWith(
		expect.objectContaining({ base: 'release' }),
	);
	const stages = mock.submissions.length;
	expect(await runActions(options)).toEqual({ outcome: 'duplicate' });
	expect(mock.submissions).toHaveLength(stages);
	expect(pulls).toHaveLength(1);
	expect(comments.filter((c) => c.user.type === 'Bot')).toHaveLength(1);
});

it('repairs an interrupted report/label checkpoint without invoking a model again', async () => {
	await runActions(options);
	comments[0].body = comments[0].body.replace(
		/<!-- factory:actions-state:[\w-]+ -->/,
		`<!-- factory:actions-state:${Buffer.from(JSON.stringify({ status: 'ready', label: 'triage: fix verified' })).toString('base64url')} -->`,
	);
	labels = ['triage: in progress'];
	mock.submissions = [];
	expect(await runActions(options)).toEqual({ outcome: 'reconciled' });
	expect(labels).toContain('triage: fix verified');
	expect(mock.submissions).toEqual([]);
});

it('reports publication failure without creating a PR or claiming a delivered fix', async () => {
	mock.failPublication = true;
	await expect(runActions(options)).rejects.toThrow(/Submodule/);
	expect(pulls).toEqual([]);
	expect(labels).toContain('triage: failed');
	expect(comments[0].body).toContain('<!-- triagebot:triage-failed -->');
	expect(comments[0].body).not.toContain('verified fix is available');
});

it('uses current closed state rather than stale opened event state', async () => {
	issueState = 'closed';
	expect(await runActions(options)).toMatchObject({ outcome: 'skipped' });
	expect(mock.submissions).toEqual([]);
	expect(comments).toEqual([]);
});

it('routes a human comment from current labels and honors a no-retriage classifier result', async () => {
	labels = ['triage: unable to reproduce'];
	mock.retriage = false;
	options.eventName = 'issue_comment';
	options.event = {
		...(options.event as object),
		action: 'created',
		comment: { id: 99, user: { login: 'reporter' } },
	};
	expect(await runActions(options)).toEqual({ outcome: 'no-retriage' });
	expect(mock.submissions).toEqual(['decision']);
	expect(mock.prepare).not.toHaveBeenCalled();
});

it('retains a legacy pending fix and verifies its submodule reachability before reusing its PR', async () => {
	labels = ['triage: fix pending'];
	comments.push({
		id: 99,
		user: { login: 'reporter' },
		body: 'Tested, it works.',
		author_association: 'NONE',
	});
	pulls.push({
		number: 20,
		html_url: 'https://github.com/owner/repo/pull/20',
		state: 'open',
		base: { ref: 'release' },
		head: { ref: 'flue/fix-10', repo: { full_name: 'owner/repo' } },
	});
	options.eventName = 'issue_comment';
	options.event = {
		...(options.event as object),
		action: 'created',
		comment: comments[0],
	};
	expect(await runActions(options)).toMatchObject({ outcome: 'fix-verified' });
	expect(mock.verifySubmodules).toHaveBeenCalled();
	expect(mock.api.rest.pulls.create).not.toHaveBeenCalled();
});
