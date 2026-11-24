import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { parseActionsConfig } from '../actions/config.ts';
import { botLogins, parseEvent } from '../actions/event.ts';
import { runPipeline, type StageRunner } from '../actions/pipeline.ts';
import { extractSubmission } from '../actions/runtime.ts';
import { assertPublicationBranch } from '../actions/workspace.ts';
import { runtimeEnvironment } from '../actions/environment.ts';
import { failureCount, branchCandidates } from '../actions/runner.ts';
import retry from '../actions/retry.cjs';

const config = `version: 1
personas: { triage: false, author: false, reviewer: false }
triage:
  skill: .agents/skills/triage
  autoPrOnFix: true
  installCommand: []
  buildCommand: []
advisories: { enabled: false }
prSafety: { enabled: false }
`;
const event = {
	repository: { full_name: 'owner/repo' },
	action: 'opened',
	issue: { number: 10, updated_at: '2026-11-24T00:00:00Z' },
};

describe('Actions configuration and routing boundary', () => {
	it('uses direct OpenAI for all pipeline and classification defaults', () => {
		expect(parseActionsConfig(config)).toMatchObject({
			model: 'openai/gpt-5.5',
			verificationModel: 'openai/gpt-5.5',
			autoPrOnFix: true,
		});
	});
	it.each([
		'review: { trigger: { label: review } }',
		'releaseSecurity: {}',
		'adversary: {}',
		'personas: { author: {} }',
		'advisories: { enabled: true }',
		'prSafety: { enabled: true }',
	])('rejects an unrelated capability: %s', (extra) => {
		const base = config.replace(
			/^personas:.*\n|^advisories:.*\n|^prSafety:.*\n/gm,
			'',
		);
		expect(() => parseActionsConfig(base + extra)).toThrow();
	});
	it('rejects duplicated preparation and gateway models', () => {
		expect(() =>
			parseActionsConfig(
				config.replace('installCommand: []', 'installCommand: npm install'),
			),
		).toThrow(/prepared workspace/);
		expect(() =>
			parseActionsConfig(
				config.replace(
					'autoPrOnFix: true',
					'model: cloudflare-ai-gateway/test',
				),
			),
		).toThrow(/direct openai/);
	});
	it('accepts issue events and gives duplicate deliveries the same identity', () => {
		expect(parseEvent('issues', event, 'owner/repo', botLogins())).toEqual(
			parseEvent('issues', structuredClone(event), 'owner/repo', botLogins()),
		);
	});
	it.each(['closed', 'assigned', 'edited'])(
		'ignores unsupported issue action %s',
		(action) => {
			expect(
				parseEvent('issues', { ...event, action }, 'owner/repo', botLogins()),
			).toBeNull();
		},
	);
	it.each([
		{ login: 'github-actions[bot]' },
		{ login: 'custom-bot', type: 'Bot' },
		{ login: 'ConfiguredBot' },
	])('ignores bot comments: %j', (user) => {
		expect(
			parseEvent(
				'issue_comment',
				{ ...event, action: 'created', comment: { id: 42, user } },
				'owner/repo',
				botLogins('configuredBot'),
			),
		).toBeNull();
	});
	it('ignores PR comments and accepts a human comment', () => {
		const payload = {
			...event,
			action: 'created',
			comment: { id: 42, user: { login: 'human' } },
		};
		expect(
			parseEvent('issue_comment', payload, 'owner/repo', botLogins())?.action,
		).toBe('comment');
		expect(
			parseEvent(
				'issue_comment',
				{ ...payload, issue: { ...event.issue, pull_request: {} } },
				'owner/repo',
				botLogins(),
			),
		).toBeNull();
	});
	it('rejects a repository mismatch', () => {
		expect(() =>
			parseEvent('issues', event, 'different/repo', botLogins()),
		).toThrow(/repository/);
	});
});

describe('Factory pipeline compatibility', () => {
	async function pipeline(overrides: Record<string, unknown> = {}) {
		const calls: string[] = [];
		const answers: Record<string, unknown> = {
			reproduce: { reproducible: true, skipped: false, skippedReason: null },
			diagnose: { confidence: 'high' },
			verify: { verdict: 'bug', confidence: 'high' },
			fix: { fixed: true, commitMessage: 'Repair the reproduced failure' },
			...overrides,
		};
		const run: StageRunner = async (stage, _prompt, schema) => {
			calls.push(stage);
			return v.parse(schema, answers[stage]);
		};
		return { result: await runPipeline(run, true), calls };
	}
	it('runs all four stages for a reproducible bug', async () => {
		const { result, calls } = await pipeline();
		expect(calls).toEqual(['reproduce', 'diagnose', 'verify', 'fix']);
		expect(result.fixed).toBe(true);
	});
	it.each(['not-actionable', 'unsupported-runtime', 'missing-details'])(
		'skips later stages for %s',
		async (reason) => {
			const { calls, result } = await pipeline({
				reproduce: {
					reproducible: false,
					skipped: true,
					skippedReason: reason,
				},
			});
			expect(calls).toEqual(['reproduce']);
			expect(result.fixed).toBe(false);
		},
	);
	it('exits when reproduction fails', async () => {
		expect(
			(
				await pipeline({
					reproduce: {
						reproducible: false,
						skipped: false,
						skippedReason: null,
					},
				})
			).calls,
		).toEqual(['reproduce']);
	});
	it.each(['low', null])(
		'exits at diagnosis confidence %s',
		async (confidence) => {
			expect((await pipeline({ diagnose: { confidence } })).calls).toEqual([
				'reproduce',
				'diagnose',
			]);
		},
	);
	it('does not fix intended behavior', async () => {
		const { calls, result } = await pipeline({
			verify: { verdict: 'intended-behavior', confidence: 'high' },
		});
		expect(calls).toEqual(['reproduce', 'diagnose', 'verify']);
		expect(result.fixed).toBe(false);
	});
	it('rejects an unstructured, duplicate, or invalid submission', () => {
		const schema = v.object({ fixed: v.boolean() });
		expect(() => extractSubmission({}, 'fix', schema)).toThrow();
		expect(() =>
			extractSubmission(
				{ fix: [{ fixed: true }, { fixed: false }] },
				'fix',
				schema,
			),
		).toThrow();
		expect(() =>
			extractSubmission({ fix: [{ fixed: 'yes' }] }, 'fix', schema),
		).toThrow();
	});
});

describe('Publication and compatibility contracts', () => {
	it.each(['main', 'master', 'origin/main', 'origin/master', 'release'])(
		'rejects protected publication branch %s',
		(branch) => {
			expect(() => assertPublicationBranch(branch, 'release')).toThrow();
		},
	);
	it('recognizes both legacy branch names and the upstream Factory name', () => {
		expect(branchCandidates(10)).toEqual([
			'triagebot/fix-10',
			'flue/fix-10',
			'factory/fix-10',
		]);
	});
	it('counts legacy and Factory failure comments once and ignores human forgeries', () => {
		expect(
			failureCount(
				[
					{ user: { type: 'Bot' }, body: '<!-- triagebot:triage-failed -->' },
					{
						user: { login: 'configured' },
						body: '<!-- factory:triage-failed --><!-- triagebot:triage-failed -->',
					},
					{ user: { login: 'human' }, body: '<!-- factory:triage-failed -->' },
				],
				botLogins('configured'),
			),
		).toBe(2);
	});
	it('passes runtime paths without copying model or publishing credentials', () => {
		expect(
			runtimeEnvironment({
				TRIAGE_DIR: '/evidence',
				OPENAI_API_KEY: 'secret',
				FACTORY_APP_PRIVATE_KEY: 'secret',
				GH_TOKEN: 'secret',
			}),
		).toEqual({ TRIAGE_DIR: '/evidence' });
	});
});

describe('OpenAI retry ownership', () => {
	const request = [
		'https://api.openai.com/v1/responses',
		{ method: 'POST', body: '{}' },
	] as const;
	const limited = (code = 'rate_limit_exceeded') =>
		new Response(
			JSON.stringify({ error: { type: 'rate_limit_error', code } }),
			{ status: 429, headers: { 'retry-after-ms': '2500' } },
		);
	it('retains the request, honors server delay, adds jitter, and passes through a successful stream', async () => {
		const delays: number[] = [];
		const calls: unknown[] = [];
		const success = new Response('event: response.completed\n\n');
		const fetch = retry.createRetryingFetch(
			async (...args: unknown[]) => {
				calls.push(args);
				return calls.length === 1 ? limited() : success;
			},
			{
				wait: async (delay: number) => {
					delays.push(delay);
				},
				random: () => 0,
				now: () => 0,
				deadline: 10000,
				log: () => {},
			},
		);
		expect(await fetch(...request)).toBe(success);
		expect(delays).toEqual([2750]);
		expect(calls[0]).toEqual(calls[1]);
	});
	it.each([
		'insufficient_quota',
		'billing_hard_limit_reached',
		'organization_usage_limit_exceeded',
	])('never retries %s', async (code) => {
		let count = 0;
		const fetch = retry.createRetryingFetch(async () => {
			count++;
			return limited(code);
		});
		expect((await fetch(...request)).status).toBe(429);
		expect(count).toBe(1);
	});
	it('stops when the server delay exceeds the remaining budget', async () => {
		const fetch = retry.createRetryingFetch(async () => limited(), {
			now: () => 0,
			deadline: 1000,
		});
		await expect(fetch(...request)).rejects.toThrow(/budget/);
	});
	it('stops on cancellation', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = retry.createRetryingFetch(async () => limited(), {
			signal: controller.signal,
		});
		await expect(fetch(...request)).rejects.toThrow();
	});
});
