# 2.13.1

Fixes found while verifying 2.13.0 in production. No database migration is required.

**Recruiter threat screening.**
- Domain-age lookups work again: the RDAP request sends a user agent (`ATS_USER_AGENT`) and the RDAP accept header, and follows the registry redirect. rdap.org had refused every request without one.
- Strong lures (an installer, a meeting-software update from a link, a piped remote script, disabling OS protection, a seed phrase or private key, running code before the call) are no longer capped with the weak signals. One is `medium`; two or more are at least `high` and `isThreat`. A plain take-home is still clean.

**Job descriptions.**
- InHire, Recruitee and Workable JDs and titles decode named HTML entities (`&agrave;`, `&iacute;`, ...), so the stored text is plain.

**Repairs.**
- `db:repair-prototype-slugs` also rewrites `external_identity` (and the ATS board token) when it embeds the bad token, including on companies an earlier run already reslugged.
- `db:repair-title-slugs` skips rows whose stored title is still a not-a-JD title, and a retitle never moves a slug onto one.
