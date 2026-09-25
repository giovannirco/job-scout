# Jev decisions

Jev answers bounded questions: choose an option, judge a yes/no condition, or score against a short rubric. It returns probabilities. Job Scout uses the [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request), separate from the chat API used to write reports and application materials.

Set `OPENROUTER_API_KEY` on the API and worker, then enable Jev in Settings > AI models. The key stays in the server environment. The default model is `typesafe/jev-1.13`; the settings also offer OpenRouter's `~typesafe/jev-latest` alias. A connection test sends a short synthetic sentence. Opening a page does not call the model.

## Where it runs

| Task | Observe | Apply |
| --- | --- | --- |
| Fast triage | Record Jev's answer, then run normal triage | Use a clear positive match; send other cases to normal triage |
| Evaluation check | Record whether claims have supporting evidence | Keep the report, but hold follow-up automation if the check fails or cannot run |
| Résumé and cover check | Record the check alongside the materials | Keep unconfirmed materials pending and leave the position's stage unchanged |

Both controls start in Observe mode when Jev is enabled. The integration itself is disabled on existing and new installations until enabled in settings.

Fast triage asks about role fit, skills, seniority, eligibility, and mandatory requirements. It can replace the short triage call only when the probability and confidence thresholds pass, each fit dimension has strong evidence, and no pay comparison is needed. It never uses a negative Jev answer to archive a role. Advertised pay, missing evidence, provider errors, and inputs over the configured size limit use normal triage. Normal triage still needs its configured writing model.

Review priority is a separate, explicit action in Pipeline and AI settings. It takes up to ten actionable positions from the existing triage order, scores their role fit, skills, and seniority, and puts clear matches before uncertain roles and mismatches. Your chosen weights sort each group. This does not rank the entire database or overwrite existing scores. Low-confidence and ineligible matches remain visible for review. Positions edited during ranking are omitted; a profile change requires a new ranking.

Each position has preview buttons for job fit, ranking, and draft checks. These record the answer without changing the position, evaluation, or approval. Existing evaluations and materials can be checked without regenerating them. In Apply mode, review a held draft and save an edited version through the materials editor before using it. A preview or Agree click does not release a hold. If the profile, position or materials change during generation, the older output is saved as a non-current draft.

## Read an answer

Choice probabilities compare the listed options. A yes/no answer is the probability of yes. A score is an average over the rubric levels, not a precise measurement of salary, seniority in years, or application success.

Confidence measures the concentration of a Choice or Score distribution. It is not a measured accuracy rate. The two thresholds control different things: minimum confidence checks the route choice; minimum probability checks that route, the supporting yes/no answers, and the combined probability of the strong-fit score levels. Adjacent strong-fit levels can both support the same route even when the score distribution is split. Neither threshold guarantees a correct decision. [TypeSafe explains the distinction](https://docs.typesafe.ai/confidence).

The result card shows both thresholds' outcome, the served model version, timing, tokens, provider-reported cost, and every answer distribution. Agree and Disagree record your judgment. Feedback records your judgment; it does not retrain the model. Compare those judgments before changing Observe to Apply; the default thresholds have not been calibrated to your job search.

## Data and limits

A fit or ranking request sends the job description and current profile evidence to OpenRouter and TypeSafe. A draft check also sends the generated text. The integration stores a hash of the input, typed answers, usage, errors, and feedback. It does not keep a second copy of the profile or draft in decision history. History follows the LLM-run retention period.

The daily Jev limit is separate from the writing-model limits and resets at midnight UTC. A request reserves its place before calling OpenRouter, including when several workers call at once. Failed requests count. Matching cached results do not use another request. Changing the model, rubric, settings, job, or profile changes the cache key. Use the new-request checkbox to compare repeated calls.

The input limit defaults to 20,000 characters and can be raised to 80,000 for longer profiles and drafts. It counts the complete request state. Oversized inputs are skipped without truncation. The model also has its own token limit; raising the character limit does not override it.

Requests have a timeout and do not retry automatically. Provider failures use normal triage, while Apply-mode draft checks keep follow-up automation on hold. A preview reports the error. The key is sent only to OpenRouter's Decisions endpoint; the browser never receives it.

## MCP

`jev_status` reads settings and usage. `jev_history` reads recent summaries. `jev_preview` runs a check on a position and may incur a charge; it leaves application state unchanged apart from decision history.

## Design choices

Jev fits before a writing model when a bounded classification can avoid a longer request. It fits afterward when claims can be compared with supplied evidence. Its scores also provide separate factors for ranking, with the arithmetic in ordinary code. It cannot write the full evaluation, find missing facts on the web, or establish that a résumé claim is true outside the supplied sources.

The official docs warn about arithmetic, date comparisons, missing context, and adversarial text. Questions identify the relevant evidence and tell the model to ignore instructions inside it. That wording is not a security boundary. Existing application permissions, deterministic filters, and approval requirements remain in charge. See [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [state design](https://docs.typesafe.ai/concepts/state), and [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring).

This implementation uses typed HTTP calls rather than introducing a second agent framework. Hosted Jev and local decision models can share an API shape while producing different probabilities. A local adapter would need its own validation and calibrated thresholds; pointing Jev settings at an arbitrary server would hide that difference.
