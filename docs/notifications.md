# Notifications

This document describes the pluggable notification transports and retry/persistence semantics.

Transports
- `NotificationTransport` is the pluggable interface implemented by providers.
- `ConsoleTransport` is the default local/dev fallback.
- `WebhookTransport` uses `WebhookService` to sign and retry deliveries to external HTTP endpoints.

Persistence
- Web/in-app notifications are persisted to the `notifications` table so UI clients can fetch missed messages after restarts.

Failure semantics
- Transport methods return a `NotificationResult` with `success: boolean` and optional `message`.
- WebhookTransport reuses `WebhookService` which implements bounded retry and DLQ fallback.

Security
- Email `to` addresses are validated with a strict sanity check and header-injection (CR/LF) is rejected.
- Web notifications validate `userId` for basic sanity; authorization (session matching) should be enforced by callers to prevent IDOR.
