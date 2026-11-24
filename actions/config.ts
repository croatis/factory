import { load } from 'js-yaml';
import { parseFactoryConfig } from '../src/config.ts';

export const ACTIONS_MODEL = 'openai/gpt-5.5';

/** Apply host defaults, then validate with Factory's canonical configuration parser. */
export function parseActionsConfig(source: string) {
	const raw = load(source) as Record<string, any>;
	if (!raw || raw.version !== 1)
		throw new Error('factory.yml must declare version: 1.');
	for (const key of ['adversary', 'review', 'releaseSecurity']) {
		if (raw[key] !== undefined)
			throw new Error(`${key} is unavailable in the Actions host.`);
	}
	if (
		raw.personas &&
		Object.values(raw.personas).some((value) => value !== false)
	) {
		throw new Error(
			'Assignment-triggered personas must be disabled in the Actions host.',
		);
	}
	if (
		raw.triage?.previewRelease ||
		raw.advisories?.enabled ||
		raw.prSafety?.enabled
	) {
		throw new Error(
			'Preview, advisory, and PR safety capabilities are unavailable in the Actions host.',
		);
	}
	const config = parseFactoryConfig(source);
	const triage = {
		...config.triage,
		model: raw.triage?.model ?? ACTIONS_MODEL,
		verificationModel: raw.triage?.verificationModel ?? ACTIONS_MODEL,
	};
	for (const model of [triage.model, triage.verificationModel]) {
		if (!/^openai\/[^\s/]+$/.test(model))
			throw new Error('Actions models must use direct openai/... specifiers.');
	}
	if (triage.installCommand.length || triage.buildCommand.length) {
		throw new Error(
			'The prepared workspace requires installCommand: [] and buildCommand: [].',
		);
	}
	if (!triage.skill) throw new Error('A repository triage skill is required.');
	if (triage.prWriterSkill)
		throw new Error(
			'A separate PR writer skill is not supported by the phase-one Actions host.',
		);
	return triage;
}
