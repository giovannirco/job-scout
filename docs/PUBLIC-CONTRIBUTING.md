# Publishing source safely

This repository contains shared application code and synthetic fixtures. Profiles, resumes, contacts, application history, transcripts, database exports, private benchmark cases and deployment credentials belong in private runtime storage. The maintainer explicitly publishes `giovannirco@gmail.com` as the commit identity.

After cloning, configure the repository before making changes:

```sh
git config core.hooksPath .githooks
git config user.name 'Giovanni Coutinho'
git config user.email giovannirco@gmail.com
git config user.signingkey 960E0491C44AD8A5
git config commit.gpgsign true
```

Install Gitleaks 8.30.1 from its official release and verify the archive checksum. Put it on PATH, or set `git config privacy.gitleaksPath /absolute/path/to/gitleaks`. Hooks fail closed when it is unavailable. They check staged content and all outgoing history, including files deleted in a later commit. The CI `public-source` check repeats content, identity and secret checks. GitHub signature rules verify the signatures cryptographically.

All commits must have the maintainer's author and committer email, a valid signature and no co-author trailers. Use locally signed commits. GitHub's merge and squash buttons use a different committer identity, so publish a tested signed branch and fast-forward master to that exact tested commit. Never weaken the identity policy just to merge through the web UI.

Use fictional companies for personal workflow examples, reserved example domains for contacts and synthetic phone numbers beginning with `155555`. Public company catalogs may list public ATS URLs, but must not annotate the operator's employment, applications or priorities. Keep benchmark inputs external. Do not add real data to tests merely to reproduce a bug.

After a history cleanup, make a fresh clone. Never merge an old checkout or push old tags: that can restore removed objects. Private backups are incident evidence and must never become public remotes.

Automated checks detect known patterns, not every possible personal fact. Local hooks can be bypassed and CI runs after a branch is pushed. Review the full staged diff before the first public push; secret push protection cannot identify every kind of personal data. Never paste private runtime output into PRs, issues or workflow logs. Changes to these guards require the same review as authentication code.

For a local extra check, set `privacy.privatePatternsFile` to an absolute path outside the checkout containing a JSON array of private strings. The scanner checks those strings without printing them. Keep that file out of Git and CI; do not upload private profile text as public workflow fixtures. Repository-level email-pattern rules are unavailable for this personal repository: hooks and the required `public-source` check enforce the author/committer policy, while GitHub enforces valid signatures.

## Local checks

Repository checks live under `.github/scripts`; application tests live beside their source. Before committing and pushing, run:

```sh
python3 .github/scripts/check-public.test.py
python3 .github/scripts/check-public.py --index
python3 .github/scripts/check-public.py HEAD
gitleaks git . --config .gitleaks.toml --log-opts=HEAD --redact --no-banner
```

The Python tests verify that the privacy guard rejects private exports, personal contact patterns and disallowed commit metadata, including data deleted later in history. They test the publishing safeguards independently of the application.
