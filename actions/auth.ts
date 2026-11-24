import { App, Octokit } from 'octokit';

export interface Credentials {
	readToken?: string;
	writeToken?: string;
	appId?: string;
	privateKey?: string;
}

/** Installation tokens are scoped to this repository and refreshed before expiry. */
export async function githubClients(
	owner: string,
	repo: string,
	credentials: Credentials,
) {
	const app =
		credentials.appId && credentials.privateKey
			? new App({
					appId: credentials.appId,
					privateKey: credentials.privateKey.replaceAll('\\n', '\n'),
				})
			: undefined;
	let token = credentials.writeToken;
	let expires = 0;
	let installationId: number | undefined;
	if (app)
		installationId = (
			await app.octokit.rest.apps.getRepoInstallation({ owner, repo })
		).data.id;
	if (!app && !token)
		throw new Error('Publishing requires an App identity or a write token.');
	async function writeToken() {
		if (app && Date.now() >= expires - 5 * 60 * 1000) {
			const response =
				await app.octokit.rest.apps.createInstallationAccessToken({
					installation_id: installationId!,
					repositories: [repo],
					permissions: {
						contents: 'write',
						issues: 'write',
						pull_requests: 'write',
					},
				});
			token = response.data.token;
			expires = Date.parse(response.data.expires_at);
			// GitHub Actions masks refreshed credentials in any later tool output.
			if (process.env.GITHUB_ACTIONS === 'true')
				console.log(`::add-mask::${token}`);
		}
		return token!;
	}
	await writeToken();
	const read = new Octokit({
		auth: credentials.readToken,
		retry: { enabled: false },
		request: { timeout: 60000 },
	});
	if (!credentials.readToken) {
		read.hook.before('request', async (request) => {
			request.headers.authorization = `token ${await writeToken()}`;
		});
	}
	return {
		read,
		writeToken,
		write: async () =>
			new Octokit({
				auth: await writeToken(),
				retry: { enabled: false },
				request: { timeout: 60000 },
			}),
	};
}
