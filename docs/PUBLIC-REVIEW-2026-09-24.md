# Public functional review — 2026-09-24

Scope: all 92 public PRs created since 2026-09-23, through public master `47c5609`. The private checkout has unrelated history and was not copied into this checkout. Review combined PR metadata, first-parent diffs, current call chains and regression tests. The security companion uses [Trail of Bits differential-review/adversarial-modeler methodology](https://github.com/trailofbits/skills) and documents its own attack paths and limits.

## Confirmed fixes

| Finding | Source / validation |
| --- | --- |
| Identical JD fallback reused another requisition or application; startup archived copies and rewired discovery links | #66 / #111: remove identity-destructive fallback and startup collapse; existing queue-integrity regressions protect distinct requisitions, workflow and reposts. Display grouping remains. |
| Boot silently ran data repairs, accepted partial failures, and updated profiles on read | #112 and repair-adding PRs: explicit transactional preview/apply with row differences, failure IDs, independent versions and rollback. Existing profile reads are pure. |
| Baseline test suite failed and PRs had no CI | #113: ten failures stemmed from identity contamination; two assertions were stale (blank public brief; still-listed board age exemption). All original assertions pass except those two intentionally corrected expectations. CI installs the lockfile, typechecks, lints, tests and builds. |
| Discovery fetches reopened archived decisions | intake path / #71: automatic discovery preserves archive status; explicit manual intake can reopen. |
| Rejected listing could match another employer's numeric ATS ID | #55: match canonical full external identity or normalized URL. |
| Clearing target roles left old include filters active | #3/#108: empty roles clear the derived gate. |
| Classification cache included fetchedAt and rescheduled unchanged work | listing-classify: fingerprint only relevant ATS workplace inputs. |
| Hourly/monthly cash could be multiplied by 1000, lose Schema.org units, or merge into annual family bands | #30/#31/#68/#108: preserve units through extraction, parsing, backfill, grouping and UI. Unknown unsupported periods stay unknown; unrelated numeric ranges are not inferred as USD pay. |
| Small eligibility/pay edits were hidden as noise | #34/#57: remove length/difference shortcuts; known formatting and incomplete-shell repairs remain noise. |
| Disappeared application questions stayed active; returning questions retained dropped marker | #94: retire absent prompts without deleting answers, restore returning prompts, skip failed harvests, exclude dropped questions from active lists/counts/drafting. |
| Home filter silently ignored listings after the first 2000 candidates | #77/#108: filter all matching candidates before pagination; regression includes 2001 rows. |
| Discovery cursors skipped equal timestamps, could replay grouped observations and were offered for incompatible sorts | #71/#90: apply timestamp+ID keyset after ranking; only observed-desc cursor mode, page mode for other sorts. |
| Entity repair changed JD text without updating revision hash | #57: synchronize revision and position hashes. |
| Concurrent first getDb calls could initialize multiple embedded database instances | shared DB access: memoize initialization; transaction-scoped context makes repair helpers use the same transaction. |

## Upgrade behavior and limitations

See [UPGRADING.md](UPGRADING.md) for a supported restored-database rehearsal. Synthetic PGlite and disposable PostgreSQL 16 exercises cover real registry preview, atomic partial-failure rollback, explicit apply, idempotent repeat apply and unchanged repeat boot. No production database was modified. Personal restored data and report contents are not published.

The old identical-JD merge may already have discarded identity/link history. This patch cannot reconstruct missing originals; consult a backup and original posting URLs. The new repair registry intentionally does not automatically unarchive historical operator decisions or recreate lost postings. Home filtering now returns correct results but evaluates the candidate set in memory; larger shared installations would benefit from indexed, database-side geographic filtering. Reports snapshot tables between steps and can be large. ATS reads can change between preview and apply.

## PR inventory

Every row below was included in the metadata/diff/current-code review. “No additional confirmed defect” means none established in this pass, not a proof of correctness. PR numbers omitted from the sequence were issues, not missing PRs. Public history was rewritten: the merge hash shown is the matching current-history merge commit, located by `Merge pull request #N`, rather than assuming GitHub's older mergeCommit OID still exists.

| PR | Title | Current merge | Disposition |
| --- | --- | --- | --- |
| [#1](https://github.com/giovannirco/job-scout/pull/1) | Skip triage when no model key is set | `f70e05f5` | No additional confirmed defect |
| [#2](https://github.com/giovannirco/job-scout/pull/2) | Recheck recent listings when the gate changes | `18bd2e9b` | No additional confirmed defect |
| [#3](https://github.com/giovannirco/job-scout/pull/3) | Use target roles as the title gate | `36ee05d5` | Empty-role gate fixed |
| [#4](https://github.com/giovannirco/job-scout/pull/4) | Keep discovery moving while new listings are fetched | `8d72391a` | No additional confirmed defect |
| [#5](https://github.com/giovannirco/job-scout/pull/5) | Let a Java role match Java Developer titles | `d00d9e4f` | No additional confirmed defect |
| [#6](https://github.com/giovannirco/job-scout/pull/6) | Drop untouched filings that miss a new title gate | `dcbc2182` | No additional confirmed defect |
| [#7](https://github.com/giovannirco/job-scout/pull/7) | Keep a listing when its company is created at the same time | `a56cfb55` | No additional confirmed defect |
| [#8](https://github.com/giovannirco/job-scout/pull/8) | Open the pipeline on filings when no model key is set | `44a569c2` | No additional confirmed defect |
| [#9](https://github.com/giovannirco/job-scout/pull/9) | Tell Today about unscored filings | `ab6ec8eb` | No additional confirmed defect |
| [#10](https://github.com/giovannirco/job-scout/pull/10) | Fold a burst of the same role into one wire line | `5c7d1ac0` | No additional confirmed defect |
| [#11](https://github.com/giovannirco/job-scout/pull/11) | Say unscored once when no verdicts exist | `4ed20a83` | No additional confirmed defect |
| [#12](https://github.com/giovannirco/job-scout/pull/12) | Treat new grad and early career as junior | `2eb80671` | No additional confirmed defect |
| [#13](https://github.com/giovannirco/job-scout/pull/13) | Start the title gate from the profile roles | `8b89deef` | Legacy boot repairs moved to explicit runner |
| [#14](https://github.com/giovannirco/job-scout/pull/14) | Explain a discovery click when no boards are due | `1b66f0c2` | No additional confirmed defect |
| [#15](https://github.com/giovannirco/job-scout/pull/15) | Keep chat closed until a model key is set | `8d9dd258` | No additional confirmed defect |
| [#16](https://github.com/giovannirco/job-scout/pull/16) | Let an engineer role match the same developer title | `366a5b63` | No additional confirmed defect |
| [#17](https://github.com/giovannirco/job-scout/pull/17) | Load the job description when the careers host hides the board | `9067ce03` | No additional confirmed defect |
| [#18](https://github.com/giovannirco/job-scout/pull/18) | Do not queue scoring when no model key is set | `b303b8ac` | No additional confirmed defect |
| [#19](https://github.com/giovannirco/job-scout/pull/19) | Save an interview transcript without queueing a brief when no key is set | `4bfa82dd` | No additional confirmed defect |
| [#20](https://github.com/giovannirco/job-scout/pull/20) | Prune production dependencies without a prompt | `3f53f8da` | No additional confirmed defect |
| [#21](https://github.com/giovannirco/job-scout/pull/21) | Explain why a listing was filtered | `6e272cc4` | No additional confirmed defect |
| [#22](https://github.com/giovannirco/job-scout/pull/22) | fix: classify a named country or city instead of unknown | `ecb78e38` | No additional confirmed defect |
| [#23](https://github.com/giovannirco/job-scout/pull/23) | fix: scan Kraken's live Ashby board and stop retrying Bitso | `23d6dfe0` | No additional confirmed defect |
| [#24](https://github.com/giovannirco/job-scout/pull/24) | fix: drop early-career filings that an old scan stored as manual | `a628f866` | Legacy boot repairs moved to explicit runner |
| [#25](https://github.com/giovannirco/job-scout/pull/25) | fix: read Elastic job descriptions from the Greenhouse board | `d4a8d7f1` | No additional confirmed defect |
| [#26](https://github.com/giovannirco/job-scout/pull/26) | fix: show every place in a collapsed role family | `55a06b6f` | No additional confirmed defect |
| [#27](https://github.com/giovannirco/job-scout/pull/27) | fix: keep a closed details list from covering the page | `b8ba54eb` | No additional confirmed defect |
| [#28](https://github.com/giovannirco/job-scout/pull/28) | fix: treat a named place with no remote marker as an office | `0a5cdc66` | No additional confirmed defect |
| [#29](https://github.com/giovannirco/job-scout/pull/29) | fix: treat London and England as an office | `dd1b8f3e` | No additional confirmed defect |
| [#30](https://github.com/giovannirco/job-scout/pull/30) | fix: show a salary range that is already written in the JD | `d643f490` | Salary units fixed |
| [#31](https://github.com/giovannirco/job-scout/pull/31) | fix: show the pay span across a role's locations | `f1cce14b` | Currency/period aggregation fixed |
| [#32](https://github.com/giovannirco/job-scout/pull/32) | fix: disable model actions inside a position when no key is set | `9495cc22` | No additional confirmed defect |
| [#33](https://github.com/giovannirco/job-scout/pull/33) | fix: point a company careers link at the board, not one opening | `1f18c594` | Legacy boot repairs moved to explicit runner |
| [#34](https://github.com/giovannirco/job-scout/pull/34) | fix: stop treating a snapshot repair as a changed JD | `4b8b4e29` | Small material edits fixed |
| [#35](https://github.com/giovannirco/job-scout/pull/35) | fix: keep a named office out of the gate | `460dcb3b` | Legacy boot repairs moved to explicit runner |
| [#36](https://github.com/giovannirco/job-scout/pull/36) | fix: group a role posted once per country | `190d7f0d` | No additional confirmed defect |
| [#37](https://github.com/giovannirco/job-scout/pull/37) | fix: drop archived offices from the passed discovery lane | `252a0e91` | Legacy boot repairs moved to explicit runner |
| [#38](https://github.com/giovannirco/job-scout/pull/38) | fix: drop country-locked remote roles when the profile is in the US | `01e1e95a` | Legacy boot repairs moved to explicit runner |
| [#39](https://github.com/giovannirco/job-scout/pull/39) | fix: mark a US place restriction as a home fit | `bb036531` | No additional confirmed defect |
| [#40](https://github.com/giovannirco/job-scout/pull/40) | fix: stop counting archived country copies as open locations | `1038b839` | No additional confirmed defect |
| [#41](https://github.com/giovannirco/job-scout/pull/41) | fix: read salary ranges written with to, and unstick a glued top | `d4c8315a` | No additional confirmed defect |
| [#42](https://github.com/giovannirco/job-scout/pull/42) | docs: describe the gate, families, and a boot with no model key | `872d7374` | No additional confirmed defect |
| [#51](https://github.com/giovannirco/job-scout/pull/51) | fix: apply the open findings from the public trial | `d90b408e` | Legacy boot repairs moved to explicit runner |
| [#52](https://github.com/giovannirco/job-scout/pull/52) | fix: treat bullet-separated cities and home-based as what they are | `9e4fab6b` | Legacy boot repairs moved to explicit runner |
| [#53](https://github.com/giovannirco/job-scout/pull/53) | fix: re-check the gate when a discovered URL is fetched | `f8b07d9f` | Legacy boot repairs moved to explicit runner |
| [#54](https://github.com/giovannirco/job-scout/pull/54) | fix: drop graduate titles and city offices the gate still kept | `42ecdd6b` | Legacy boot repairs moved to explicit runner |
| [#55](https://github.com/giovannirco/job-scout/pull/55) | fix: load greenhouse locations from the board, not the careers page | `c2702672` | Board-scoped identity fixed |
| [#56](https://github.com/giovannirco/job-scout/pull/56) | fix: use the office when a board location is N/A or HQ | `d0b9f816` | Legacy boot repairs moved to explicit runner |
| [#57](https://github.com/giovannirco/job-scout/pull/57) | fix: stop treating a filled-in snapshot as an employer edit | `04aa2f06` | Materiality and revision hash fixed |
| [#58](https://github.com/giovannirco/job-scout/pull/58) | fix: drop frontend, SRE, and data-engineering titles for a backend north star | `2a98e0ba` | Legacy boot repairs moved to explicit runner |
| [#59](https://github.com/giovannirco/job-scout/pull/59) | fix: drop support, solutions, and QA titles for a backend north star | `f989c0b7` | Legacy boot repairs moved to explicit runner |
| [#60](https://github.com/giovannirco/job-scout/pull/60) | fix: keep a missing model key from looking like a broken queue | `b018e95c` | Legacy boot repairs moved to explicit runner |
| [#61](https://github.com/giovannirco/job-scout/pull/61) | fix: label software roles and show the employer behind an aggregator | `aa552c6d` | Legacy boot repairs moved to explicit runner |
| [#62](https://github.com/giovannirco/job-scout/pull/62) | fix: show a readable salary and drop OS-level titles | `81557df2` | Legacy boot repairs moved to explicit runner |
| [#63](https://github.com/giovannirco/job-scout/pull/63) | fix: stop calling an unscored filing untriaged | `85e57ecd` | Legacy boot repairs moved to explicit runner |
| [#64](https://github.com/giovannirco/job-scout/pull/64) | fix: drop image, Ubuntu, and data-platform titles for this north star | `fd2784e7` | Legacy boot repairs moved to explicit runner |
| [#65](https://github.com/giovannirco/job-scout/pull/65) | fix: show why a north star archived a role | `30c663b5` | No additional confirmed defect |
| [#66](https://github.com/giovannirco/job-scout/pull/66) | fix: keep one filing when a board repeats the same JD | `24e9dfa2` | Identity merge and boot collapse removed |
| [#67](https://github.com/giovannirco/job-scout/pull/67) | Trust the office when it disagrees with the Greenhouse location | `812f3121` | Legacy boot repairs moved to explicit runner |
| [#68](https://github.com/giovannirco/job-scout/pull/68) | Read salary ranges and match search across dashes | `919810b2` | Structured salary units fixed |
| [#69](https://github.com/giovannirco/job-scout/pull/69) | Show US city lists as home, and say not scored | `30c72b56` | Legacy boot repairs moved to explicit runner |
| [#70](https://github.com/giovannirco/job-scout/pull/70) | Apply the US place chip to stored filings | `e43f87d8` | Legacy boot repairs moved to explicit runner |
| [#71](https://github.com/giovannirco/job-scout/pull/71) | Collapse repeated discovery rows and drop archived filings from Passed | `f7962a99` | Archive preservation and discovery pagination fixed |
| [#72](https://github.com/giovannirco/job-scout/pull/72) | Count Discovery Passed as filings | `ae1eca33` | No additional confirmed defect |
| [#73](https://github.com/giovannirco/job-scout/pull/73) | Show Changed only after a real edit | `b3777e6e` | No additional confirmed defect |
| [#74](https://github.com/giovannirco/job-scout/pull/74) | Show companies that still have an open role | `d4931d43` | No additional confirmed defect |
| [#75](https://github.com/giovannirco/job-scout/pull/75) | Label employment and distinguish company roles | `faf8b041` | No additional confirmed defect |
| [#76](https://github.com/giovannirco/job-scout/pull/76) | Space glued hyphens and hold research without a key | `83a0bb58` | Legacy boot repairs moved to explicit runner |
| [#77](https://github.com/giovannirco/job-scout/pull/77) | Filter the pipeline by home and hide archived company roles | `34dac8b4` | Home candidate cap removed |
| [#78](https://github.com/giovannirco/job-scout/pull/78) | Show both ends of a pay range and honest add-URL copy | `44f0c878` | No additional confirmed defect |
| [#79](https://github.com/giovannirco/job-scout/pull/79) | Use plain language in JD history and show pay on the board | `bdc4679b` | No additional confirmed defect |
| [#80](https://github.com/giovannirco/job-scout/pull/80) | Don't report a WhatsApp test as sent without WAHA | `af56e28b` | No additional confirmed defect |
| [#81](https://github.com/giovannirco/job-scout/pull/81) | Label quiet hours and the skip action | `a603d891` | No additional confirmed defect |
| [#82](https://github.com/giovannirco/job-scout/pull/82) | Keep search and the open list on work you can still act on | `be80cd1f` | No additional confirmed defect |
| [#83](https://github.com/giovannirco/job-scout/pull/83) | Make discovery listings openable and stop promising a triage that will not run | `9caa12bf` | No additional confirmed defect |
| [#84](https://github.com/giovannirco/job-scout/pull/84) | Match reversed backend titles and stop calling a repair an update | `30a095a9` | Legacy boot repairs moved to explicit runner |
| [#85](https://github.com/giovannirco/job-scout/pull/85) | Let application answers be typed, and name where a role came from | `8570c22f` | No additional confirmed defect |
| [#86](https://github.com/giovannirco/job-scout/pull/86) | Show the gate and the role facts the way they are actually applied | `0ef4d81b` | No additional confirmed defect |
| [#87](https://github.com/giovannirco/job-scout/pull/87) | Show how many application questions a role has | `f327d645` | No additional confirmed defect |
| [#88](https://github.com/giovannirco/job-scout/pull/88) | Show when the employer posted a role | `98858069` | No additional confirmed defect |
| [#89](https://github.com/giovannirco/job-scout/pull/89) | Name the sort you are on, and show old postings in years | `62cfe82e` | No additional confirmed defect |
| [#90](https://github.com/giovannirco/job-scout/pull/90) | Show the employer posted date on discovery and company pages | `5b8eb258` | Discovery cursor contract fixed |
| [#91](https://github.com/giovannirco/job-scout/pull/91) | Show the team under a role when the title does not say which team it is | `71b7a94c` | No additional confirmed defect |
| [#92](https://github.com/giovannirco/job-scout/pull/92) | Let a team name find the role | `a1de5671` | No additional confirmed defect |
| [#93](https://github.com/giovannirco/job-scout/pull/93) | Open lists on the employer posted date | `5a8c809f` | No additional confirmed defect |
| [#94](https://github.com/giovannirco/job-scout/pull/94) | Show required fields and choices on application forms | `b94d15ae` | Application question lifecycle fixed |
| [#95](https://github.com/giovannirco/job-scout/pull/95) | Accept several form choices and show the posted date | `2ee1c2b7` | No additional confirmed defect |
| [#96](https://github.com/giovannirco/job-scout/pull/96) | Show every office and the employment type | `9e6a4d8d` | Legacy boot repairs moved to explicit runner |
| [#97](https://github.com/giovannirco/job-scout/pull/97) | Show cities behind Distributed and link the company site | `cea5138f` | Legacy boot repairs moved to explicit runner |
| [#108](https://github.com/giovannirco/job-scout/pull/108) | Fix the leftover issues in one pass | `dae0609b` | Profile reads, empty roles, mixed salary units and home filtering fixed |
| [#109](https://github.com/giovannirco/job-scout/pull/109) | Clean BambooHR places and withdraw roles the gate now rejects | `175abaf5` | No additional confirmed defect |
| [#110](https://github.com/giovannirco/job-scout/pull/110) | Describe the scanners, gate, and forms the way the code works | `47c56095` | Upgrade/profile documentation updated |

## Validation

Baseline: 432 passed / 12 failed (444 tests). Bugfix branch: 461 tests passed across 52 files; typecheck, build and lint passed (323 advisory warnings). PostgreSQL 16 repair tests: 5 passed. The CLI preview/apply both succeeded with 24 completed steps skipped on the already-repaired synthetic database, and reports had mode 0600. Combined security validation is recorded in the PR description. Lint passes with existing advisory warnings; strict zero-warning lint is not claimed. Browser layout was reviewed in source and built, not subjected to a complete visual/end-to-end audit. No live ATS, model, notification or cluster deployment smoke test is claimed.
