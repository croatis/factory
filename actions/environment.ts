/** Shell access is local to this runner. This allowlist is hygiene, not a security sandbox. */
export const RUNTIME_ENVIRONMENT = [
	'CI',
	'CI_CERT_DIR',
	'CI_CA_BUNDLE',
	'TRIAGE_SOURCE_REPOSITORY',
	'TRIAGE_SOURCE_REVISION',
	'TRIAGE_DIR',
	'TRIAGE_REPOSITORY',
	'TRIAGE_COMPOSE_OVERRIDE',
	'COMPOSE_FILE',
	'COMPOSE_PROJECT_NAME',
	'PLAYWRIGHT_CHROME_EXECUTABLE',
	'APPDATA',
	'TestSettings__ArtifactsDirectory',
	'TRIAGE_RUN_ID',
	'TRIAGE_RUN_ATTEMPT',
	'TRIAGE_BOOTSTRAP_PASSWORD_FILE',
	'DOCKER_HOST',
	'DOCKER_CONTEXT',
	'DOCKER_CONFIG',
	'GITHUB_WORKSPACE',
	'GITHUB_REPOSITORY',
	'GITHUB_RUN_ID',
	'GITHUB_RUN_ATTEMPT',
	'GITHUB_SERVER_URL',
] as const;

export function runtimeEnvironment(env: NodeJS.ProcessEnv = process.env) {
	return Object.fromEntries(
		RUNTIME_ENVIRONMENT.filter((name) => env[name] !== undefined).map(
			(name) => [name, env[name]],
		),
	);
}
