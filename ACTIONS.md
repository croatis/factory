# Factory Triage on GitHub Actions

Upstream baseline: `withastro/factory@3a01af8566a580c3cefd5d1f06e1884679a1f135`.
The MIT license and upstream history are retained. The Worker host remains available separately.

The Actions host uses Flue 2.3.0's `start()` and `local()` APIs on Node 24.22.3.
It registers only the Factory Triage pipeline, RetriageJudge, FixVerifier, and direct OpenAI provider.
It has no HTTP listener. It does not initialize AI Gateway or require Cloudflare or Anthropic credentials.
Factory contracts, state routing, stage prompts, classifiers, progress rendering, label helpers, and PR schemas are shared with upstream.

## Consumer configuration

Prepare the target repository in `GITHUB_WORKSPACE`, including recursive submodules and local tools.
Create `.github/factory.yml` with version 1, a repository triage skill, empty install/build commands,
and direct `openai/...` models. The Actions defaults are `openai/gpt-5.5` for both models.
Disable personas, advisories, and PR safety. Omit review, adversary, release-security, and preview configuration.
Only issue opened/reopened and human issue-comment-created events are admitted.

Reference this repository's root action with a reviewed, full commit SHA.
The action installs its dedicated lockfile beside its own bundle, outside the target checkout.
It uses the existing workspace for edits, build tools, tests, and Git publication. It never clones the application again.
Keep issue-level workflow concurrency with cancellation disabled. Upload evidence and run teardown with `always()`.

For renewable publishing credentials, supply `app-id` and `app-private-key`. The App must have Contents,
Issues, and Pull requests write permissions and be installed on the target repository.
Tokens are restricted to that repository and refreshed five minutes before expiry.
`read-token` may be supplied separately. `write-token` is a fallback whose expiry is reported as an authentication
failure; a static token cannot be renewed without the App credentials.
Submodule credentials belong to the checkout preparation and must have access to each owning repository.

Pass `deadline-ms` as an absolute Unix timestamp that leaves time for artifact upload and teardown.
Without it, the adapter allows 110 minutes from startup. OpenAI rate-limit retries preserve the current request
and conversation, honor delay headers, add jitter, and stop on cancellation or the deadline.
Quota/billing errors are not retried. Pi request retries and Flue recovery attempts are disabled in this host.
The retry implementation is adapted from MicroserviceBootstrap's `triage-openai-retry.cjs`.

## Stage and publication ownership

Each stage uses the shared Factory pipeline in a fresh conversation. Only that stage's submit tool is registered.
The repository's compact findings and evidence files carry context between stages. The skill must not launch
its own stage subagents in this mode. Skipped/unreproducible reports, low/null diagnosis confidence, and intended
behavior all terminate the appropriate stages before a fix is attempted.

The orchestrator commits and pushes the superproject. With `allow-submodule-publication: true`, the agent may
perform repository-required submodule commits and pushes. Before publishing a parent pointer, the runner checks
that each retained gitlink matches a clean checkout and is reachable from freshly fetched remote branch refs,
including nested submodules. A local-only SHA or stale tracking ref cannot establish publication.

When application startup is mandatory, set `required-runtime-state` to the workspace JSON readiness file.
The host requires `status: "ready"` and `provisioned: true` after a successful reproduction and before new fix
publication. Missing, invalid, or failed readiness stops the pipeline with an infrastructure failure report.
The workflow owns generation of fresh readiness evidence for its checkout and attempt. Publication checkpoints
retain the successful readiness check so a later delivery can recover without repeating application startup.
Unchecked older publication checkpoints cannot be recovered when this guard is enabled. Completed duplicate
events and human confirmation of existing legacy fixes retain their normal routing.

New fix branches use `triagebot/fix-<issue>`. Existing `flue/fix-<issue>` and `factory/fix-<issue>` branches and PRs
remain recognized. Existing branch history is preserved; pushes are never forced. Multiple candidate open PRs
or a mismatched base stop publication for maintainer reconciliation. PRs target the current repository default
branch, and protected/default branch names cannot be publication heads.

Current issue state is fetched before routing. Reports use a stable event marker, independent of workflow retry
attempts. A report checkpoint is persisted before label updates and marked complete afterward; a rerun repairs
that boundary without repeating the investigation. An interrupted investigation starts a fresh local conversation
against current GitHub state. Agent conversation persistence ends with the job.

After a branch push, a publication checkpoint also retains its exact SHA and PR content. If PR creation or
later reporting fails, rerunning that delivery verifies the remote SHA and submodules, then finishes delivery
without another investigation. A changed remote branch stops recovery for reconciliation. A previously merged
branch that is an ancestor of the current default is fast-forwarded before investigating a reopened issue.

Factory progress comments and `triage: in progress` are retained. Failure comments include both Factory and
legacy failure markers, counted once by this host. Three recorded failures stop automatic retries while the
failure state remains set. A completed failure before publication needs a new human comment to request another
attempt. Failures with a publication checkpoint can resume on the same delivery. Intended behavior uses the not-actionable label. No issue-close cleanup,
persona handoff, preview release, or package publishing runs in this host.

## Trust boundary

The local shell runs on the Actions runner with access to the checkout and permitted local tooling.
The environment allowlist avoids passing model keys and publishing credentials directly to shell tools.
It is not Cloudflare Sandbox isolation: code with host shell access can inspect accessible files and processes.
Use disposable runners, scoped credentials, repository-controlled skills/configuration, and the runtime wrapper's
existing secret handling. Never upload runtime credential files or raw model conversation logs as artifacts.

## Build and verification

Use Node 24.22.3 and pnpm 10.28.0:

```sh
pnpm install --frozen-lockfile
pnpm check:actions
pnpm test
pnpm build:actions
npm ci --prefix actions --ignore-scripts
```

The action distribution includes `actions/dist/index.mjs`, `actions/package.json`, and its lockfile.
Run the built distribution with `mode: proof` and an OpenAI project key before release.
The proof reads and writes a random nonce in the prepared workspace with local tools and returns Factory's
structured reproduction submission. It creates no GitHub comments, labels, branches, or PRs.
Its evidence is `.triagebot/factory-proof/result.json`.

Model calls, including classifiers and compaction, also emit numeric usage records to the job log and
`model-usage.jsonl` in the evidence directory. These contain no prompts, tool arguments, or response bodies.
Cost fields are estimates from the pinned provider SDK's model table, not authoritative billing records.

Run controlled root and nested-submodule pilots after the proof. Test rollback before enabling all issue events.
Keep the old action available until pilot evidence is reviewed. For upstream updates, merge on a feature branch,
review shared contracts and host boundaries, rebuild the distribution, and rerun compatibility and live proof checks.
