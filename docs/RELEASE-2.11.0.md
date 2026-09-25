# 2.11.0

Jev previews and automatic checks now use the same listing evidence. Checks include the stored company overview and fall back to the latest job-description location when normalized location fields are missing. This prevents supported employer claims from being flagged merely because a preview omitted their source.

The larger input limit introduced in 2.10.1 remains available for complete profiles and drafts. Production settings control Observe or Apply independently of the release. This version adds no database migration.
