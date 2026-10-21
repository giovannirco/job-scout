# 2.14.1

`create_position_from_career_ops` no longer creates a position for a tracker row the tracker dropped (Discarded, SKIP…, Withdrawn) when no existing position matches it. It answers `skipped: true` with `reason: "tracker_dropped"`. An existing match is still linked and stamped, the same rule `reconcile_career_ops` follows since 2.14.0. No database migration.
