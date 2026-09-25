-- =====================================================
-- 036: Post-Phase-2 correction — remove service_role EXECUTE from the four
-- user-actor RPCs
-- =====================================================
--
-- Root cause (confirmed from the repository, not guessed):
-- 035_fn_session_activity_and_evaluation_functions.sql revoked EXECUTE on
-- the four user-actor functions from `public, anon, authenticated` and then
-- granted it back to `authenticated` — but, unlike the dormant, backend-only
-- and private-helper blocks in the same file, it never named `service_role`
-- in those four REVOKE statements. Supabase's platform default privileges
-- for the `public` schema grant EXECUTE on every newly created function
-- directly to anon, authenticated AND service_role (a direct ACL entry per
-- role, not something inherited from PUBLIC), so service_role simply kept
-- the grant it received at CREATE time. The user's postflight SQL
-- (has_function_privilege('service_role', ..., 'EXECUTE') = true for these
-- four) is exactly that retained direct grant.
--
-- Intended Phase 2 matrix for these four functions:
--   PUBLIC: no EXECUTE · anon: no EXECUTE · authenticated: EXECUTE ·
--   service_role: no EXECUTE.
-- They derive the acting user from auth.uid(); a service-role caller has no
-- end-user identity of its own to act as, and no application code calls
-- them with the service client (save-progress and session/restart use the
-- caller's own RLS-respecting client; studySession.ts takes the caller's
-- client too). Nothing else loses access.
--
-- Scope, deliberately narrow:
--   - exact, full signatures only (each of these names has exactly one
--     overload in migrations 001-035; the assertion block below fails the
--     migration if any other overload exists, rather than leaving one
--     silently uncorrected);
--   - no role-membership changes, no ALTER DEFAULT PRIVILEGES, no change to
--     any other function's ACL or any helper's SECURITY mode;
--   - the authenticated grant is re-issued idempotently so the end state
--     does not depend on what 035 left behind.
--
-- Self-verifying: the DO block at the end checks EFFECTIVE privileges with
-- has_function_privilege() (which accounts for PUBLIC and inherited role
-- membership, not just the direct ACL) and raises — rolling back this whole
-- migration — if the intended matrix does not hold afterward. If it raises
-- because service_role still has EXECUTE through role inheritance, the fix
-- is NOT to broaden this migration; see PHASE2_RUNBOOK.md §"036".
--
-- Plan: .claude/video-learning-management-plan.md §12, "Post-Phase-2 repair".

revoke execute on function fn_get_or_create_study_session(text, uuid) from public, anon, service_role;
revoke execute on function fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text) from public, anon, service_role;
revoke execute on function fn_legacy_save_progress(uuid, text, uuid, integer, numeric, numeric, integer, text) from public, anon, service_role;
revoke execute on function fn_legacy_restart_round(text, uuid) from public, anon, service_role;

grant execute on function fn_get_or_create_study_session(text, uuid) to authenticated;
grant execute on function fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text) to authenticated;
grant execute on function fn_legacy_save_progress(uuid, text, uuid, integer, numeric, numeric, integer, text) to authenticated;
grant execute on function fn_legacy_restart_round(text, uuid) to authenticated;

do $$
declare
  v_sig text;
  v_overloads integer;
  v_name text;
begin
  -- Every overload is accounted for: exactly one function per name.
  foreach v_name in array array[
    'fn_get_or_create_study_session', 'fn_flush_study_activity',
    'fn_legacy_save_progress', 'fn_legacy_restart_round'
  ] loop
    select count(*) into v_overloads
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name;
    if v_overloads <> 1 then
      raise exception '036: expected exactly 1 overload of %, found %', v_name, v_overloads;
    end if;
  end loop;

  foreach v_sig in array array[
    'public.fn_get_or_create_study_session(text, uuid)',
    'public.fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text)',
    'public.fn_legacy_save_progress(uuid, text, uuid, integer, numeric, numeric, integer, text)',
    'public.fn_legacy_restart_round(text, uuid)'
  ] loop
    if not has_function_privilege('authenticated', v_sig, 'EXECUTE') then
      raise exception '036: authenticated lacks EXECUTE on %', v_sig;
    end if;
    if has_function_privilege('anon', v_sig, 'EXECUTE') then
      raise exception '036: anon still has EXECUTE on %', v_sig;
    end if;
    if has_function_privilege('service_role', v_sig, 'EXECUTE') then
      raise exception '036: service_role still has effective EXECUTE on % (check role membership: pg_auth_members)', v_sig;
    end if;
    -- PUBLIC holds no direct grant (an empty-grantee aclitem would show as "=X/...").
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = v_sig::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
      raise exception '036: PUBLIC still has EXECUTE on %', v_sig;
    end if;
  end loop;
end;
$$;
