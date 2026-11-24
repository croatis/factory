import { createHash } from 'node:crypto';
import { isBotAuthor } from '../src/github/bots.ts';

export function botLogins(value = ''): Set<string> {
	return new Set(
		['github-actions[bot]', ...value.split(',')]
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

export function isBot(
	user: { login?: string; type?: string } | null | undefined,
	bots: Set<string>,
): boolean {
	const login = user?.login?.toLowerCase();
	return (
		user?.type === 'Bot' || (!!login && (isBotAuthor(login) || bots.has(login)))
	);
}

/** Reject unsupported events before obtaining credentials or starting the model runtime. */
export function parseEvent(
	name: string,
	payload: any,
	repository: string,
	bots: Set<string>,
) {
	if (
		payload.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
	) {
		throw new Error('The event repository does not match GITHUB_REPOSITORY.');
	}
	if (!payload.issue || payload.issue.pull_request) return null;
	const action: 'opened' | 'reopened' | 'comment' | null =
		name === 'issues' && ['opened', 'reopened'].includes(payload.action)
			? (payload.action as 'opened' | 'reopened')
			: name === 'issue_comment' && payload.action === 'created'
				? 'comment'
				: null;
	if (!action || (action === 'comment' && isBot(payload.comment?.user, bots)))
		return null;
	if (!Number.isSafeInteger(payload.issue.number) || payload.issue.number < 1)
		throw new Error('Invalid issue number.');
	const eventKey =
		action === 'comment' ? payload.comment?.id : payload.issue.updated_at;
	if (!eventKey) throw new Error('Missing stable event identifier.');
	const id = createHash('sha256')
		.update(`${repository}:${payload.issue.number}:${action}:${eventKey}`)
		.digest('hex');
	return {
		number: payload.issue.number as number,
		action,
		id,
		commentId: payload.comment?.id as number | undefined,
	};
}
