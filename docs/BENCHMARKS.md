# Local model benchmarks

Benchmark inputs and outputs can contain application history, candidate profiles, resumes and model transcripts. Keep them outside the public checkout. The application reads profile and job content from the configured runtime database; no personal benchmark cases ship with the source.

For `triage` or `heavy`, pass `--cases /private/path/cases.json` or set `BENCH_CASES`. Example schema using fictional identifiers:

```json
{
  "triage": [{ "slug": "acme-platform-engineer", "expect": "pass", "why": "Meets the synthetic candidate criteria" }],
  "heavy": ["acme-platform-engineer"]
}
```

These slugs must exist in your own database. Use `BENCH_OUT` to put results in a private directory. `chat` uses fictional examples; `judge` and `report` read previous local results. The benchmark script is excluded from the runtime image.
