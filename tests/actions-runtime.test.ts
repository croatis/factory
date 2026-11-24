import { expect, it } from 'vitest';
import { startRuntime } from '../actions/runtime.ts';

it('boots and stops the pinned Node runtime without Cloudflare or Anthropic credentials or a listener', async () => {
	const runtime = await startRuntime();
	expect(runtime.stop).toBeTypeOf('function');
	await runtime.stop();
});
