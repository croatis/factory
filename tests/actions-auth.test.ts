import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
	now: Date.parse('2026-11-24T00:00:00Z'),
	scopes: [] as any[],
	before: null as any,
	denied: false,
	octokits: [] as any[],
}));
vi.mock('octokit', () => ({
	App: class {
		octokit = {
			rest: {
				apps: {
					getRepoInstallation: async () => ({ data: { id: 7 } }),
					createInstallationAccessToken: async (options: any) => {
						if (mock.denied)
							throw new Error('Installation cannot grant contents write');
						mock.scopes.push(options);
						return {
							data: {
								token: `token-${mock.scopes.length}`,
								expires_at: new Date(mock.now + 3600000).toISOString(),
							},
						};
					},
				},
			},
		};
	},
	Octokit: class {
		hook = {
			before: (_event: string, fn: unknown) => {
				mock.before = fn;
			},
		};
		constructor(options: any) {
			mock.octokits.push(options);
		}
	},
}));
import { githubClients } from '../actions/auth.ts';

beforeEach(() => {
	mock.scopes = [];
	mock.octokits = [];
	mock.before = null;
	mock.denied = false;
	mock.now = Date.parse('2026-11-24T00:00:00Z');
	vi.spyOn(Date, 'now').mockImplementation(() => mock.now);
});
afterEach(() => vi.restoreAllMocks());

it('requests the three publishing scopes for only the target repository and refreshes before expiry', async () => {
	const clients = await githubClients('owner', 'repo', {
		appId: 'app',
		privateKey: 'key',
	});
	expect(await clients.writeToken()).toBe('token-1');
	expect(mock.scopes).toEqual([
		{
			installation_id: 7,
			repositories: ['repo'],
			permissions: {
				contents: 'write',
				issues: 'write',
				pull_requests: 'write',
			},
		},
	]);
	mock.now += 56 * 60000;
	expect(await clients.writeToken()).toBe('token-2');
	expect(mock.scopes).toHaveLength(2);
	const request = { headers: {} as Record<string, string> };
	await mock.before(request);
	expect(request.headers.authorization).toBe('token token-2');
});

it('fails before model execution when the installation cannot grant required permissions', async () => {
	mock.denied = true;
	await expect(
		githubClients('owner', 'repo', { appId: 'app', privateKey: 'key' }),
	).rejects.toThrow(/cannot grant/);
});

it('allows a static token fallback without pretending it can refresh it', async () => {
	const clients = await githubClients('owner', 'repo', {
		writeToken: 'static',
	});
	expect(await clients.writeToken()).toBe('static');
	mock.now += 120 * 60000;
	expect(await clients.writeToken()).toBe('static');
	expect(mock.scopes).toEqual([]);
});
