---
status: accepted
---

# Direct downloads require verified tokens

A direct-download URL is a bearer credential: whoever holds it reads the object from storage until it expires, without asking the server again. The runtime token's `repository_id` and `ac` claims are all that stand between a caller and that URL, and with `SKIP_TOKEN_VALIDATION=true` they are decoded but not verified, so any client that reaches the server could name any repository and walk away with a signed URL for its cache. The server therefore refuses to start with `ENABLE_DIRECT_DOWNLOADS=true` and `SKIP_TOKEN_VALIDATION=true` together, unless `UNSAFE_ALLOW_DIRECT_DOWNLOADS_WITHOUT_TOKEN_VALIDATION=true` overrides it for local testing. This extends ADR-0006: skipping verification stays a dev/test escape hatch, and the one feature that turns an unverified claim into a storage credential is out of its reach. Setups that ran both flags stop at startup after upgrading.

A signed URL lives `DIRECT_DOWNLOAD_URL_TTL_SECONDS`, 600 by default (the fixed lifetime before the setting existed) and at most 3600. Clients request the URL right before fetching it, so the lifetime only has to cover the start of the transfer and retries; a shorter one limits replay of a URL that leaks into job logs, while clients that hold a URL and fetch it later, such as BuildKit's `type=gha` cache, need a longer one. The Storage Reader Lease outlives the URL by a fixed margin (ADR-0002).

Verified tokens must carry `exp`; GitHub's always do, and a token without one would never expire. The optional `ACTIONS_TOKEN_AUDIENCE` lists accepted `aud` values and then requires one of them, restricting the server to tokens issued for one installation; a value that lists none (only commas) stops startup rather than silently disabling the check. Scope permissions are bit flags (read 1, write 2): lookups use only scopes with the read bit and saves only scopes with the write bit, and a scope without a name or with a malformed permission rejects the token. Rejections log the error kind and claim name, never the token or claim values.
