# Decision record: yt-dlp for transcript fetching — not added

Date: 2026-09-08
Status: Decided (revisit after production data — see "Revisit criteria" below)

## Decision

`yt-dlp` is **not** added as a transcript-fetch fallback in this change. The
English transcript pipeline now has two providers — the `youtube-transcript`
npm package, then a raw InnerTube fallback (`src/lib/youtubeCaptions/`) — plus
manual paste / `.srt` / `.vtt` import as a first-class, always-available
fallback. `yt-dlp` was considered and deliberately deferred.

## Why not now

1. **It's still unofficial extraction.** `yt-dlp`'s YouTube extractor scrapes
   the same InnerTube/player-response surface this codebase already talks
   to directly. It doesn't have a legitimate, sanctioned data source the two
   providers here lack — it's a more elaborate client for the same
   unofficial API, with its own maintenance burden when YouTube changes
   internals.

2. **It does not inherently solve datacenter-IP blocking.** The dominant
   failure mode this project has actually observed (per the diagnostic
   logging already present before this change, and the reasoning behind
   `YOUTUBE_BOT_BLOCKED`/`YOUTUBE_RATE_LIMITED` in
   `src/lib/youtubeCaptions/errors.ts`) is YouTube treating Vercel's
   datacenter IPs as suspicious. `yt-dlp` hits the same IPs from the same
   kind of infrastructure and is blocked by the same mechanism unless paired
   with cookies, PO tokens, or proxies — all three explicitly out of scope
   for this project (see constraints below).

3. **Cookies / PO tokens / proxies are out of scope on their own merits, not
   just as an implementation detail.** They mean shipping and rotating
   account credentials or paid proxy infrastructure for what is a personal
   learning app, and they meaningfully change the security/privacy posture
   (credentials to protect, ToS exposure, a bigger blast radius if
   compromised). This project's constraints rule them out regardless of
   which fetch library sits behind them.

4. **Runtime/deployment complexity.** `yt-dlp` is a Python binary (or a
   Node wrapper shelling out to one). Next.js API routes on Vercel are not
   a natural home for spawning an external process — it would need either a
   custom serverless bundle step (shipping a Python interpreter + binary
   through `@vercel/nft`'s dependency tracing) or a separate worker/service
   entirely, both of which are new infrastructure this app doesn't currently
   have, for a personal project maintained by one person.

5. **Marginal expected benefit given what's already fixed.** Investigation
   for this change found that a meaningful share of prior "no captions"
   failures were not IP blocking at all, but a real bug: the
   `youtube-transcript` package requires an *exact* `languageCode === "en"`
   match, so a video whose only English track is `en-US`/`en-GB` (no bare
   `en`) was incorrectly reported as caption-less. The InnerTube fallback's
   track-selection logic (`src/lib/youtubeCaptions/trackSelection.ts`)
   already fixes this class of failure without `yt-dlp`. Adding `yt-dlp` on
   top, before knowing how much *remaining* failure is genuinely IP-block-driven
   vs. something the two-provider approach already recovers, risks paying
   its complexity cost for little additional coverage.

## Revisit criteria

Reconsider `yt-dlp` (or a hosted transcript API, if the "no paid provider"
constraint is later relaxed) only after production data from this
two-provider implementation answers:

- **Automatic fetch failure rate** — what fraction of `/api/transcript/generate`
  calls end in a genuine typed error (not cooldown/lock contention), from the
  `transcript_fetch_completed` metric events (`src/lib/youtubeCaptions/metrics.ts`).
- **Parser-incompatibility vs. IP-block split** — of those failures, how many
  carry `PARSER_ERROR`/`INVALID_PROVIDER_RESPONSE`/`LANGUAGE_NOT_FOUND`
  (fixable in-process, already addressed here) vs.
  `YOUTUBE_RATE_LIMITED`/`YOUTUBE_BOT_BLOCKED` (would need a fundamentally
  different fetch strategy, which is the only case `yt-dlp` might actually
  help with — and only if paired with the cookies/proxies this project
  currently rules out).
- **innerTube-raw fallback recovery rate** (`fallback_success` outcomes,
  `fallbackUsed: true`) — how much of the package provider's failure the
  second provider already recovers on its own.
- **Vercel bundle/runtime constraints at the time** — whether Vercel's
  Node/Python function support or bundle-size limits have changed in a way
  that makes shipping `yt-dlp` (or delegating to a separate worker) less
  costly than it is today.
- **Security implications** of whatever `yt-dlp` configuration would
  actually be needed to meaningfully help (cookies/PO tokens/proxies are
  the parts that matter for bypassing IP blocks — a cookie-less,
  proxy-less `yt-dlp` invocation is not meaningfully different from what
  the raw InnerTube provider already does).
- **Whether a separate worker/service would be required** — and whether the
  ongoing maintenance burden (a second deployable, a second set of
  extractor-breakage failure modes to track) is worth it for a
  single-maintainer personal project.

Do not add a `yt-dlp` implementation stub, feature flag, or disabled code
path in the meantime — nothing here should make it possible to accidentally
enable `yt-dlp` before this decision is deliberately revisited.
