# 2.10.1

Jev's configurable input limit now allows up to 80,000 characters, so longer profiles can be checked without removing evidence. The default remains 20,000. Settings explains that the limit includes profile evidence, the job and any draft.

Inputs above the chosen limit still skip Jev and follow the existing fallback or review behavior. The model's separate token limit still applies. This update does not change profiles, truncate requests or add a database migration.
