-- Restricts vocabulary_audio_assets and the vocabulary-audio Storage bucket
-- to service-role-only access. Migration 018 modeled both on
-- vocabulary_translation_cache's public-read pattern, but unlike that
-- table (a dictionary translation cache, not sensitive), this one stores
-- `text`/`normalized_text` — the exact term/phrase from a user's saved
-- vocabulary item — which this app treats as private, not for public
-- distribution. Nothing in the app's own client code ever needs public
-- access to either the table or the bucket: every read/write already goes
-- through the service-role client (src/lib/vocabularyAudioCache.ts), and
-- POST /api/vocabulary/pronounce resolves a fresh, time-limited playback
-- URL per authenticated, ownership-checked request (resolvePlaybackUrl,
-- via Storage's createSignedUrl) rather than a permanent public one. The
-- public policies from 018 therefore only ever added unnecessary exposure
-- — anyone holding the public anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY,
-- shipped to every browser) could otherwise read every user's saved
-- vocabulary text directly from vocabulary_audio_assets, and enumerate/
-- fetch every generated audio file from the bucket.
--
-- Deployment order: apply after 018 (or together, in numeric order, on a
-- project where 018 has not yet been applied — this migration does not
-- depend on any data 018 may or may not have written). Idempotent via
-- `drop policy if exists`, safe to run whether or not 018's policies still
-- exist under their original names.
--
-- Handling of previously issued public URLs: this app never persists a
-- resolved audioUrl beyond one pronunciation button's in-memory lifetime
-- (never written to localStorage, a cookie, or the database — only
-- storage_path/asset id are persisted, both private identifiers, not
-- URLs), so there is no durable record of a public URL anywhere in this
-- codebase to migrate. If 018 was already deployed to a live project with
-- real traffic, any public URL a client happens to be holding in an
-- already-open browser tab will start returning 403 the moment this
-- bucket flips to private — expected, and self-resolving: that tab's next
-- pronunciation tap (or a page reload) calls the pronounce route again and
-- receives a fresh, working signed URL.

drop policy if exists "vocabulary_audio_assets_public_read" on vocabulary_audio_assets;
create policy "vocabulary_audio_assets_service_read"
  on vocabulary_audio_assets for select
  using (auth.role() = 'service_role');

drop policy if exists "vocabulary_audio_public_read" on storage.objects;
create policy "vocabulary_audio_service_read"
  on storage.objects for select
  using (bucket_id = 'vocabulary-audio' and auth.role() = 'service_role');

update storage.buckets set public = false where id = 'vocabulary-audio';
