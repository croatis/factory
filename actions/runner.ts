import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as v from 'valibot';
import type { Octokit } from 'octokit';
import { githubClients, type Credentials } from './auth.ts';
import { parseActionsConfig } from './config.ts';
import { botLogins, isBot, parseEvent } from './event.ts';
import {
	containedPath,
	git,
	prepareWorkspace,
	publishWorkspace,
	verifySubmodulePublication,
} from './workspace.ts';
import { runPipeline, type StageRunner } from './pipeline.ts';
import { ActionsTriagePipeline } from './agent.ts';
import { startRuntime, submit } from './runtime.ts';
import { RetriageJudge } from '../src/triage/agents/retriage-judge.ts';
import { FixVerifier } from '../src/triage/agents/fix-verifier.ts';
import {
	retriageDecisionSchema,
	fixVerdictSchema,
} from '../src/triage/contracts.ts';
import { route } from '../src/triage/fsm.ts';
import {
	allTriageLabels,
	currentTriageLabel,
	labelAppearance,
} from '../src/triage/labels.ts';
import { resolveTriageLabel } from '../src/triage/resolve-label.ts';
import {
	MAX_TRIAGE_FAILURES,
	formatFailureComment,
} from '../src/triage/failure.ts';
import {
	formatTriageProgress,
	triageProgressMarker,
	type TriageProgressState,
} from '../src/triage/progress.ts';
import {
	commentResultSchema,
	labelSelectionSchema,
	prContentSchema,
	type PrContent,
} from '../src/triage/pipeline-contracts.ts';
import {
	commentStepPrompt,
	labelSelectionPrompt,
	prContentPrompt,
} from '../src/triage/prompts.ts';
import {
	ensureLabelExists,
	replaceIssueLabels,
	fetchRepoLabels,
	partitionClassificationLabels,
	computePriorityLabelsToRemove,
	removeLabelIfPresent,
	addIssueLabels,
} from '../src/github/issues.ts';

export interface RunOptions {
	eventName: string;
	event: unknown;
	repository: string;
	workspace: string;
	credentials: Credentials;
	botLogins?: string;
	evidenceDirectory?: string;
	allowSubmodulePublication: boolean;
	signal: AbortSignal;
}

export function failureCount(
	comments: Array<{ body?: string | null; user?: any }>,
	bots: Set<string>,
) {
	return comments.filter(
		(comment) =>
			isBot(comment.user, bots) &&
			/<!-- (?:triagebot|factory):triage-failed -->/.test(comment.body ?? ''),
	).length;
}

export function branchCandidates(number: number) {
	return [
		`triagebot/fix-${number}`,
		`flue/fix-${number}`,
		`factory/fix-${number}`,
	];
}

/** Reconcile current GitHub state before any model calls or application startup. */
export async function runActions(options: RunOptions) {
	const bots = botLogins(options.botLogins);
	const event = parseEvent(
		options.eventName,
		options.event,
		options.repository,
		bots,
	);
	if (!event) return { outcome: 'ignored' };
	const [owner, repo] = options.repository.split('/');
	const clients = await githubClients(owner, repo, options.credentials);
	const read = clients.read;
	const { data: repository } = await read.rest.repos.get({ owner, repo });
	const defaultBranch = repository.default_branch;
	const configPath = await containedPath(
		options.workspace,
		'.github/factory.yml',
	);
	const config = parseActionsConfig(await readFile(configPath, 'utf8'));
	if (!config.enabled)
		return { outcome: 'ignored', reason: 'Triage is disabled.' };
	const key = { owner, repo, issue_number: event.number };
	const marker = triageProgressMarker(event.id);
	const comments = await read.paginate(read.rest.issues.listComments, {
		...key,
		per_page: 100,
	});
	let existing = comments.find(
		(c) => isBot(c.user, bots) && c.body?.includes(marker),
	);
	let commentId = existing?.id;
	const checkpointPattern = /<!-- factory:actions-state:([A-Za-z0-9_-]+) -->/;
	const previous = [
		...(existing?.body ?? '').matchAll(new RegExp(checkpointPattern, 'g')),
	].at(-1);
	const checkpoint = previous
		? JSON.parse(Buffer.from(previous[1], 'base64url').toString('utf8'))
		: undefined;

	async function state(label: string) {
		if (!allTriageLabels(config.labels).includes(label))
			throw new Error('Unknown triage state.');
		const api = await clients.write();
		await ensureLabelExists(
			api,
			owner,
			repo,
			label,
			labelAppearance(label, config.labels),
		);
		// Remove only triage labels; unrelated labels and concurrent maintainer changes survive.
		await replaceIssueLabels(
			api,
			owner,
			repo,
			event!.number,
			allTriageLabels(config.labels),
			label,
		);
	}
	async function save(body: string) {
		const api = await clients.write();
		const marked = body.includes(marker) ? body : `${body}\n\n${marker}`;
		if (commentId) {
			try {
				await api.rest.issues.updateComment({
					owner,
					repo,
					comment_id: commentId,
					body: marked,
				});
			} catch (error) {
				if ((error as { status?: number }).status !== 404) throw error;
				commentId = undefined;
				return save(marked);
			}
		} else {
			// Re-read before a POST, including when a previous request committed but lost its reply.
			const current = await api.paginate(api.rest.issues.listComments, {
				...key,
				per_page: 100,
			});
			const found = current.find(
				(c) => isBot(c.user, bots) && c.body?.includes(marker),
			);
			if (found) {
				commentId = found.id;
				return save(marked);
			}
			try {
				commentId = (
					await api.rest.issues.createComment({
						...key,
						body: marked,
						request: { retries: 0 },
					})
				).data.id;
			} catch (error) {
				const after = await api.paginate(api.rest.issues.listComments, {
					...key,
					per_page: 100,
				});
				const committed = after.find(
					(c) => isBot(c.user, bots) && c.body?.includes(marker),
				);
				if (!committed) throw error;
				commentId = committed.id;
			}
		}
	}
	const checkpointText = (
		status: string,
		label?: string,
		publication?: unknown,
	) =>
		`<!-- factory:actions-state:${Buffer.from(JSON.stringify({ status, label, publication })).toString('base64url')} -->`;
	if (checkpoint?.status === 'done') return { outcome: 'duplicate' };
	if (checkpoint?.status === 'ready') {
		if (checkpoint.label) await state(checkpoint.label);
		await save(
			existing!.body!.slice(0, previous!.index) +
				checkpointText('done', checkpoint.label),
		);
		return { outcome: 'reconciled' };
	}
	const { data: issue } = await read.rest.issues.get(key);
	if (issue.pull_request) return { outcome: 'ignored' };
	const labels = issue.labels.map((label) =>
		typeof label === 'string' ? label : (label.name ?? ''),
	);
	let action = route(
		{
			action: event.action,
			issueState: issue.state === 'closed' ? 'closed' : 'open',
			issueLabels: labels,
		},
		config.labels,
	);
	if (action.type === 'skip' || action.type === 'cleanup')
		return { outcome: 'skipped', reason: 'No active Triage route.' };
	const failures = failureCount(comments, bots);
	if (
		[config.labels.failed, config.labels.inProgress].includes(
			currentTriageLabel(labels, config.labels) ?? '',
		) &&
		failures >= MAX_TRIAGE_FAILURES
	) {
		await state(config.labels.failed);
		return {
			outcome: 'skipped',
			reason: 'Maximum automatic failures reached.',
		};
	}
	const evidence = resolve(
		options.workspace,
		options.evidenceDirectory ?? `.triagebot/gh-${event.number}`,
	);
	await mkdir(evidence, { recursive: true });
	await containedPath(options.workspace, evidence);
	const progress: TriageProgressState = {
		current: 'workspace',
		includeInstall: false,
		includeBuild: false,
		details: {},
		skipped: {},
	};
	let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
	let published:
		| { branch: string; sha: string; pr: PrContent | null }
		| undefined;
	async function finish(body: string, label?: string) {
		// Commit the report to GitHub before labels, then mark completion. A rerun repairs this boundary.
		await save(`${body}\n\n${checkpointText('ready', label)}`);
		if (label) await state(label);
		await save(`${body}\n\n${checkpointText('done', label)}`);
	}
	const conversation = comments.map((c) => ({
		author: c.user?.login ?? 'ghost',
		association: c.author_association,
		isBot: isBot(c.user, bots),
		body: c.body ?? '',
	}));
	const classifierInput = {
		owner,
		repo,
		issueNumber: event.number,
		issueTitle: issue.title,
		issueBody: issue.body ?? '',
		conversation,
		model: config.verificationModel,
		thinkingLevel: config.verificationThinkingLevel,
	};
	async function findFix() {
		const candidates = branchCandidates(event!.number);
		const pulls = await read.paginate(read.rest.pulls.list, {
			owner,
			repo,
			state: 'open',
			per_page: 100,
		});
		const matches = pulls.filter(
			(p) =>
				p.head.repo?.full_name === options.repository &&
				candidates.includes(p.head.ref),
		);
		if (matches.length > 1)
			throw new Error(
				'Multiple existing fix PRs require maintainer reconciliation.',
			);
		if (matches[0]) {
			if (matches[0].base.ref !== defaultBranch)
				throw new Error('The existing fix PR targets a different base.');
			return { branch: matches[0].head.ref, existing: true, pull: matches[0] };
		}
		for (const branch of candidates) {
			try {
				await read.rest.repos.getBranch({ owner, repo, branch });
				return { branch, existing: true, pull: undefined };
			} catch (error) {
				if ((error as { status?: number }).status !== 404) throw error;
			}
		}
		return { branch: candidates[0], existing: false, pull: undefined };
	}
	async function openPull(branch: string, content: PrContent, newFix = false) {
		const api = await clients.write();
		const matching = await api.rest.pulls.list({
			owner,
			repo,
			state: 'all',
			head: `${owner}:${branch}`,
			per_page: 100,
		});
		const open = matching.data.find(
			(p) => p.state === 'open' && p.base.ref === defaultBranch,
		);
		if (!open && !newFix && matching.data.some((p) => p.merged_at))
			throw new Error(
				'The existing fix was merged. Retriage requires a new branch policy decision.',
			);
		const pull =
			open ??
			(
				await api.rest.pulls.create({
					owner,
					repo,
					head: branch,
					base: defaultBranch,
					...content,
				})
			).data;
		await ensureLabelExists(
			api,
			owner,
			repo,
			config.labels.prFixVerified,
			labelAppearance(config.labels.prFixVerified, config.labels),
		);
		await addIssueLabels(api, owner, repo, pull.number, [
			config.labels.prFixVerified,
		]);
		return pull.html_url;
	}
	try {
		if (checkpoint?.status === 'published') {
			published = v.parse(
				v.object({
					branch: v.string(),
					sha: v.string(),
					pr: v.nullable(prContentSchema),
				}),
				checkpoint.publication,
			);
			if (!branchCandidates(event.number).includes(published.branch))
				throw new Error('Invalid publication checkpoint branch.');
			const remote = await read.rest.repos.getBranch({
				owner,
				repo,
				branch: published.branch,
			});
			if (remote.data.commit.sha !== published.sha)
				throw new Error(
					'The published branch changed after the checkpoint; reconcile it before retrying.',
				);
			const recovered = await prepareWorkspace(
				options.workspace,
				published.branch,
				defaultBranch,
				true,
				await clients.writeToken(),
			);
			if (recovered.head !== published.sha)
				throw new Error(
					'The checkout changed after the publication checkpoint.',
				);
			await verifySubmodulePublication(options.workspace);
			options.signal.throwIfAborted();
			if ((await read.rest.issues.get(key)).data.state !== 'open')
				throw new Error('The issue closed before publication.');
			const url = published.pr
				? await openPull(published.branch, published.pr, true)
				: undefined;
			await finish(
				`Recovered the verified fix published by the interrupted run at commit ${published.sha}.\n\n${url ? `[Review the pull request](${url}).` : `The fix is on branch ${published.branch}.`}\n\nReview the original run's diagnostic artifacts for its test evidence.`,
				url ? config.labels.fixVerified : config.labels.needsTriage,
			);
			return { outcome: 'reconciled-publication', url };
		}
		runtime = await startRuntime(evidence);
		if (action.type === 'retriage') {
			const decision = await submit(
				RetriageJudge,
				`${event.id}:retriage`,
				classifierInput,
				'Review the new comments and call submit_retriage_decision.',
				'decision',
				retriageDecisionSchema,
				options.signal,
			);
			if (!decision.retriage) {
				await finish(`No new triage is needed.\n\n${decision.reasoning}`);
				return { outcome: 'no-retriage' };
			}
		}
		const fix = await findFix();
		if (action.type === 'verify-fix') {
			const comment = comments.find((c) => c.id === event.commentId);
			if (!comment || isBot(comment.user, bots))
				throw new Error('The triggering human comment is no longer available.');
			if (!fix.existing) throw new Error('The pending fix branch is missing.');
			const verdict = await submit(
				FixVerifier,
				`${event.id}:verify-fix`,
				{
					...classifierInput,
					branch: fix.branch,
					defaultBranch,
					latestComment: {
						author: comment.user?.login ?? 'ghost',
						association: comment.author_association,
						isBot: false,
						body: comment.body ?? '',
					},
				},
				'Classify the triggering comment and call submit_fix_verification.',
				'verdict',
				fixVerdictSchema,
				options.signal,
			);
			if (verdict.status !== 'confirmed') {
				await finish(
					verdict.reasoning,
					verdict.status === 'rejected' ? config.labels.fixRejected : undefined,
				);
				return { outcome: `fix-${verdict.status}` };
			}
			if (!verdict.pr) throw new Error('Confirmed fix is missing PR content.');
			await prepareWorkspace(
				options.workspace,
				fix.branch,
				defaultBranch,
				true,
				await clients.writeToken(),
			);
			await verifySubmodulePublication(options.workspace);
			if ((await read.rest.issues.get(key)).data.state !== 'open')
				throw new Error('The issue closed before publication.');
			const url = await openPull(fix.branch, verdict.pr);
			await finish(
				`The fix was confirmed.\n\n${verdict.reasoning}\n\n[Review the pull request](${url}).`,
				config.labels.fixVerified,
			);
			return { outcome: 'fix-verified', url };
		}
		await state(config.labels.inProgress);
		await save(formatTriageProgress(event.id, progress));
		const workspace = await prepareWorkspace(
			options.workspace,
			fix.branch,
			defaultBranch,
			fix.existing,
			await clients.writeToken(),
		);
		const skill = await containedPath(options.workspace, config.skill!);
		await readFile(resolve(skill, 'SKILL.md'), 'utf8');
		const input = {
			...classifierInput,
			issueAuthor: issue.user?.login ?? 'ghost',
			issueAuthorAssociation: issue.author_association,
			sandboxId: event.id,
			defaultBranch,
			fixBranch: fix.branch,
			skillName: 'triage',
			skillDirectory: skill,
			workspace: options.workspace,
			evidence,
			allowSubmodulePublication: options.allowSubmodulePublication,
			model: config.model,
			thinkingLevel: config.thinkingLevel,
		};
		const run: StageRunner = async (stage, prompt, schema) => {
			options.signal.throwIfAborted();
			if (['reproduce', 'diagnose', 'verify', 'fix'].includes(stage)) {
				progress.current = stage as typeof progress.current;
				await save(formatTriageProgress(event.id, progress));
			}
			const result = await submit(
				ActionsTriagePipeline,
				`${event.id}:${stage}`,
				{ ...input, stage },
				prompt,
				stage,
				schema,
				options.signal,
			);
			await writeFile(
				resolve(evidence, `${stage}-submission.json`),
				JSON.stringify(result, null, 2),
			);
			return result;
		};
		const result = await runPipeline(run, options.allowSubmodulePublication);
		for (const stage of ['diagnose', 'verify', 'fix'] as const) {
			if (
				!result.reproducible ||
				result.skipped ||
				(stage !== 'diagnose' &&
					!['medium', 'high'].includes(result.diagnosisConfidence ?? '')) ||
				(stage === 'fix' && result.verdict === 'intended-behavior')
			)
				progress.skipped[stage] = 'pipeline early exit';
		}
		progress.current = 'publish';
		await save(formatTriageProgress(event.id, progress));
		let url: string | undefined;
		let pushed = false;
		if (result.fixed) {
			const content = config.autoPrOnFix
				? await run(
						'pr',
						prContentPrompt(event.number, fix.branch, defaultBranch),
						prContentSchema,
					)
				: null;
			options.signal.throwIfAborted();
			if ((await read.rest.issues.get(key)).data.state !== 'open')
				throw new Error('The issue closed before publication.');
			const publication = await publishWorkspace({
				workspace: options.workspace,
				branch: fix.branch,
				defaultBranch,
				expectedHead: workspace.head,
				expectedOrigin: workspace.origin,
				repository: options.repository,
				message: result.commitMessage!,
				token: await clients.writeToken(),
			});
			pushed = true;
			published = { branch: fix.branch, sha: publication.sha, pr: content };
			await save(
				formatTriageProgress(event.id, progress) +
					'\n\n' +
					checkpointText('published', undefined, published),
			);
			await writeFile(
				resolve(evidence, 'publication.json'),
				JSON.stringify(publication, null, 2),
			);
			if (content) url = await openPull(fix.branch, content, true);
		}
		const { priorityLabels, packageLabels } = partitionClassificationLabels(
			await fetchRepoLabels(read, owner, repo),
		);
		const report = await run(
			'comment',
			commentStepPrompt({
				repo: options.repository,
				issueNumber: event.number,
				branchName: pushed ? fix.branch : null,
				priorityLabels,
			}),
			commentResultSchema,
		);
		const selection = await run(
			'labels',
			labelSelectionPrompt(priorityLabels, packageLabels),
			labelSelectionSchema,
		);
		if (
			(selection.priority &&
				!priorityLabels.some((l) => l.name === selection.priority)) ||
			selection.packages.some(
				(name) => !packageLabels.some((l) => l.name === name),
			)
		)
			throw new Error('The agent selected an unknown classification label.');
		const api = await clients.write();
		const freshLabels = (await read.rest.issues.get(key)).data.labels.map(
			(l) => (typeof l === 'string' ? l : (l.name ?? '')),
		);
		for (const label of computePriorityLabelsToRemove(
			freshLabels,
			selection.priority,
			priorityLabels,
		)) {
			await removeLabelIfPresent(api, owner, repo, event.number, label);
		}
		await addIssueLabels(api, owner, repo, event.number, [
			...(selection.priority ? [selection.priority] : []),
			...selection.packages,
		]);
		const label =
			result.verdict === 'intended-behavior'
				? config.labels.notActionable
				: resolveTriageLabel(result, config.labels, {
						previewReleaseAvailable: false,
						prOpened: !!url,
					});
		progress.current = 'complete';
		await finish(
			formatTriageProgress(
				event.id,
				progress,
				report.comment + (url ? `\n\n[Review the pull request](${url}).` : ''),
			),
			label,
		);
		return { outcome: 'triaged', label, url };
	} catch (error) {
		// Credentials and raw shell/provider errors must never enter public issue comments.
		const status = (error as { status?: number }).status;
		const reason =
			status === 401 || status === 403
				? 'GitHub authentication or installation permissions failed; publication was not confirmed.'
				: options.signal.aborted
					? 'The run exceeded its budget or was cancelled.'
					: 'The automated run failed. Review the private Actions logs and diagnostic artifacts.';
		progress.failed = true;
		const body = formatTriageProgress(
			event.id,
			progress,
			formatFailureComment(reason, failures + 1).replace(
				'<!-- factory:triage-failed -->',
				'<!-- factory:triage-failed -->\n<!-- triagebot:triage-failed -->',
			),
		);
		if (published) {
			await save(
				body + '\n\n' + checkpointText('published', undefined, published),
			).catch(() => {});
			await state(config.labels.failed).catch(() => {});
		} else await finish(body, config.labels.failed).catch(() => {});
		throw error;
	} finally {
		await runtime?.stop();
	}
}
