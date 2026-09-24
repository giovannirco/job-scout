# 2.10.0

Jev can assess job fit, rank a review queue and check generated claims against profile and job evidence. Configure it in Settings > AI models with an OpenRouter key in the server environment. Jev starts disabled; Observe records decisions alongside the existing workflow. Apply can use clear positive triage results or hold follow-up automation for uncertain drafts.

Position previews show answer probabilities, model version, latency and cost. MCP adds `jev_status`, `jev_history` and `jev_preview`. The materials editor lets an operator save a reviewed version while retaining previous drafts.

Requests have a daily limit, a timeout and a cache. Decision history stores input hashes and answers without another copy of source text. Startup adds the `decision_runs` table. Existing profiles, jobs and settings are preserved.

The default thresholds have not been calibrated to job-search outcomes. Start with Observe and compare decisions before relying on Apply. See [Jev setup and behavior](JEV.md).
