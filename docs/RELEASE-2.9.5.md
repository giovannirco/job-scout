# 2.9.5

- Chat preserves the final message and completion events when closing a stream.
- AI requests respect cancellation before sending, release cancellation listeners, and report empty or incomplete responses as failures.
- Authentication verifies sessions and Cloudflare Access tokens. Browser requests enforce trusted origins, and public-page fetches reject private network destinations.
- Browser assistance is limited to reading and navigation, with explicit network isolation required.
- Data repairs run only when explicitly requested. The repair command supports `--list` and `--steps` for selecting corrections; selected repairs commit together or roll back on failure.

See [Security](SECURITY.md) for authentication and network configuration, and [Upgrading](UPGRADING.md) for the database repair procedure.
