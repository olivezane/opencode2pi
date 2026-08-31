# Register the static list at startup; refresh the catalog in the background

pi's documented pattern for dynamic model discovery is an async extension
factory that awaits the first fetch before `registerProvider` (pi blocks
startup until the factory resolves). We deliberately deviate: the factory is
synchronous and registers the S3 static list immediately, while the live
catalog (S1 live fetch ∩ free-by-metadata, S2 disk cache) refreshes in the
background and re-registers when it lands.

Why: pi startup is interactive, and this package's primary audience sits
behind flaky networks (VPN/TUN reconnects, DNS hiccups) — the exact scenario
where awaiting a fetch would hang or time out. The static list is the
verified fallback tier, so the picker is never empty and never blocks;
models upgrade in place a few seconds later when the live catalog lands.
Considered and rejected: the async-factory pattern (startup latency on
broken networks, plus timeout/fallback machinery); it remains the obvious
choice for anyone porting this elsewhere with reliable networking.

Constraint: pi forbids starting timers in the extension factory (it may run
in invocations that never start a session), so the catalog refresh loop
starts on the first `session_start`, not in the factory. The factory itself
stays synchronous — the no-blocking guarantee is unchanged. Each refresh
round re-registers the provider object with rebuilt models; pi replaces it
in place.
