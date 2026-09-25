# 2.12.0

New positions and meaningful JD changes now queue a Jev job-fit check when Jev triage is enabled. Checks use the current profile and latest job description, independently of writing-model automation. Results appear in Jev history and the position timeline without changing pipeline stages, scores or application materials.

The worker skips closed or inactive positions, superseded changes and disabled checks, and respects the separate Jev request limit. Unchanged and cosmetic edits do not schedule extra checks. A job description filled in after an empty initial snapshot does receive a check.

Automatic checks can reuse normal triage decisions in the same mode. Manual previews use a separate cache so automatic activity remains visible. No database migration is required.
