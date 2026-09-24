# Public repository rules

This checkout publishes to `giovannirco/job-scout`. Confirm the remote before editing or pushing; the separate `job-scout-private` checkout must never be copied or pushed here.

Keep personal profiles, resumes, contacts, application history, model transcripts, production settings, credentials and database exports outside this repository. Use synthetic fixtures and reserved example domains. Read-only production investigation does not authorize copying production output into source, tests, commits, issues, PRs or logs.

Before committing, enable `.githooks` with `git config core.hooksPath .githooks`. Install checksum-verified Gitleaks and configure `privacy.gitleaksPath` if it is not on PATH. Run `python3 scripts/check-public.test.py`, `python3 scripts/check-public.py --index` and the appropriate application tests. Before pushing, run the full-history privacy and Gitleaks checks described in `docs/PUBLIC-CONTRIBUTING.md`. Do not bypass failing hooks or weaken checks to publish a change.

Author and committer must both be `Giovanni Coutinho <giovannirco@gmail.com>`. Sign every commit with the maintainer's registered key `960E0491C44AD8A5`. Do not add co-author trailers, including automated-assistant attribution. Do not use GitHub-generated merge/squash commits, whose committer identity differs. Fast-forward master to a signed commit that has passed the required checks.

After a history rewrite, use a fresh clone. Never merge or push pre-cleanup history or tags. Automated scans are only a guardrail; inspect the actual diff for private information before its first public push.
