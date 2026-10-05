"""Kiro Crew's own Kiro credential as a credit-usage source.

The defect this source closes: ``GET /api/sessions/usage`` was refused with 503
``kiro_prerequisite_required`` whenever the kiro-cli readiness latch was not
verified-ready, which is the STANDING state of an install that runs another
harness and never signs kiro-cli in. The dashboard rendered that refusal as
"could not read your balance" -- a failed read of a balance nobody had asked
anyone for. Crew already holds a refreshable Kiro OIDC identity of its own in
KAS mode, so there was a credential, and a reading, the whole time.

Equally important and asserted here: this is ADDITIVE. Users have not been
migrated to Crew's own OIDC, so the kiro-cli-owned install must read exactly
what it read before -- same candidate order, same call, same fallbacks.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import kiro_crew.dashboard.handlers.kiro_usage_api as usage_api
import kiro_crew.dashboard.handlers.sessions as sessions_mod
import kiro_crew.dashboard.handlers.usage_crew_credential as crew_cred

_SOON = datetime.now(timezone.utc) + timedelta(hours=1)
_ARN = "arn:aws:codewhisperer:us-west-2:123456789012:profile/ABCDEFGHIJKL"


def _vault(token: str = "vault-token", arn: str | None = _ARN) -> usage_api.VaultCredential:
    return usage_api.VaultCredential(token=token, expiry=_SOON, profile_arn=arn)


def _reset_usage_globals() -> None:
    sessions_mod._usage_cache = {}
    sessions_mod._usage_cache_ts = 0.0
    sessions_mod._usage_fetching = False
    sessions_mod._usage_scrape_failures = 0
    sessions_mod._usage_scrape_backoff_until = 0.0


@pytest.fixture(autouse=True)
def _clean_usage_globals():
    _reset_usage_globals()
    yield
    _reset_usage_globals()


def _api_result(usage, auth_state=usage_api.AUTH_OK):
    return usage_api.UsageResult(usage, auth_state)


# --------------------------------------------------------------------------
# The candidate list: added at the front, never replacing what was there.
# --------------------------------------------------------------------------


class TestVaultJoinsTheCandidateList:
    def test_vault_is_tried_before_every_enumerated_store(self, monkeypatch):
        """Provenance ranks above expiry, and this is the strongest provenance.

        A bystander store can hold a FRESHER token that belongs to a profile the
        user has since left -- the wrong-account readout this module's ordering
        exists to prevent. Crew's own credential is the account this process
        signed in, so it goes first even against a later expiry.
        """
        later = datetime.now(timezone.utc) + timedelta(hours=9)
        monkeypatch.setattr(
            usage_api,
            "_candidate_tokens",
            lambda: [usage_api._Candidate("cli-token", later, from_cli_store=True)],
        )
        seen: list[str] = []

        def _probe(token, *, expected_arn=None, endpoint=None):
            seen.append(token)
            return None  # reject everything so the walk visits every candidate

        monkeypatch.setattr(usage_api, "_list_profile_arn", _probe)
        usage_api.fetch_usage_limits(_ARN, vault=_vault())

        assert seen[0] == "vault-token", "Crew's own credential must be tried first"
        assert "cli-token" in seen, "the enumerated stores must still be tried"

    def test_no_vault_leaves_the_candidate_list_untouched(self, monkeypatch):
        """The backward-compatibility assertion: no vault, nothing changes."""
        enumerated = [usage_api._Candidate("cli-token", _SOON, from_cli_store=True)]
        monkeypatch.setattr(usage_api, "_candidate_tokens", lambda: list(enumerated))
        seen: list[str] = []

        def _probe(token, *, expected_arn=None, endpoint=None):
            seen.append(token)
            return None

        monkeypatch.setattr(usage_api, "_list_profile_arn", _probe)
        usage_api.fetch_usage_limits(_ARN)

        assert seen == ["cli-token"]

    def test_a_token_held_by_both_is_tried_once(self, monkeypatch):
        """Dedupe by value: one bearer, one probe, with the trusted provenance."""
        monkeypatch.setattr(
            usage_api,
            "_candidate_tokens",
            lambda: [usage_api._Candidate("shared", _SOON, from_cli_store=False)],
        )
        seen: list[str] = []

        def _probe(token, *, expected_arn=None, endpoint=None):
            seen.append(token)
            return None

        monkeypatch.setattr(usage_api, "_list_profile_arn", _probe)
        usage_api.fetch_usage_limits(None, vault=_vault(token="shared", arn=None))

        assert seen == ["shared"], "the same bearer must not be probed twice"

    def test_vault_satisfies_the_source_anchored_proof(self, monkeypatch):
        """An identity with no profile ARN is still PROVEN, so it is not skipped.

        Source-anchored mode refuses a credential it cannot attribute. Crew's own
        vault is attributable for the same reason kiro-cli's own store is -- it
        is the credential of the account this process signed in -- so a Builder
        ID / social identity keeps the direct API path instead of being pushed
        onto the lossier text scrape.
        """
        monkeypatch.setattr(usage_api, "_candidate_tokens", lambda: [])
        probed: list[str] = []

        def _probe(token, *, expected_arn=None, endpoint=None):
            probed.append(token)
            return None

        monkeypatch.setattr(usage_api, "_list_profile_arn", _probe)
        usage_api.fetch_usage_limits(None, vault=_vault(arn=None))

        assert probed == ["vault-token"], (
            "a credential Crew itself signed in must not be refused for lacking an ARN"
        )


# --------------------------------------------------------------------------
# Resolving the credential: an optional source that can never break a refresh.
# --------------------------------------------------------------------------

class TestLabellingTheStoredIdentity:
    """Crew's stored kind, translated into the vocabulary the panel branches on.

    One vocabulary is the requirement: the account panel must not have to know
    which credential answered in order to label the account, so the translation
    happens here rather than a second set of branches happening there.
    """

    @pytest.mark.parametrize(
        ("identity", "provider", "expected"),
        [
            ("builder_id", "BuilderId", "BuilderId"),
            ("identity_center", "Enterprise", "IamIdentityCenter"),
            ("external_idp", "ExternalIdp", "ExternalIdp"),
            ("social", "Google", "SocialGoogle"),
            ("social", "Github", "SocialGithub"),
        ],
    )
    def test_every_stored_kind_gets_whoamis_spelling(self, identity, provider, expected):
        assert crew_cred._account_type(identity, provider) == expected

    @pytest.mark.parametrize(
        ("identity", "provider"),
        [
            # A social issuer outside the KAS contract's fixed set. Concatenating
            # it would invent a label the panel then humanizes and shows.
            ("social", "Facebook"),
            ("social", ""),
            # A kind added to the store later, before this table learns it.
            ("something_new", "Whatever"),
            (None, None),
            ("", ""),
        ],
    )
    def test_an_unrecognised_kind_yields_no_label(self, identity, provider):
        assert crew_cred._account_type(identity, provider) is None

    def test_the_labels_are_the_ones_the_panel_branches_on(self):
        """Pin the contract to its consumer, not to this table.

        `accountProviderLabel` in `website/src/components/KiroAccountModal.tsx`
        special-cases exactly these spellings; anything else falls through to a
        humanized raw string. A rename on either side has to break a test, or the
        account line silently degrades to "Builder Id" and nobody notices.
        """
        panel = (
            Path(__file__).resolve().parents[1]
            / "website/src/components/KiroAccountModal.tsx"
        ).read_text(encoding="utf-8")
        assert "'IamIdentityCenter'" in panel
        assert "'BuilderId'" in panel
        assert "'Social'" in panel


class TestResolvingCrewsCredential:
    @pytest.mark.asyncio
    async def test_no_stored_identity_costs_no_provider(self, monkeypatch):
        """The cheap probe answers first, so the usual install pays almost nothing.

        Without it every 30s tick on a kiro-cli-owned gateway would build a
        provider, and an install carrying a LAPSED Crew identity would attempt a
        network refresh on each one.
        """
        built = MagicMock()
        monkeypatch.setitem(
            __import__("sys").modules,
            "kiro_crew.auth.bridge",
            SimpleNamespace(
                default_token_store=built,
                vault_holds_identity=lambda: False,
            ),
        )
        monkeypatch.setitem(
            __import__("sys").modules,
            "kiro_crew.auth.provider",
            SimpleNamespace(KasAuthProvider=MagicMock(), NotAuthenticated=Exception),
        )

        assert await crew_cred.crew_vault_credential() is None
        built.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_refresh_failure_degrades_instead_of_raising(self, monkeypatch):
        """One of several sources: it must never propagate out of the refresh."""

        class _Boom(Exception):
            pass

        class _Provider:
            def __init__(self, *a, **k):
                pass

            async def current(self):
                raise _Boom("refresh endpoint said no")

        monkeypatch.setitem(
            __import__("sys").modules,
            "kiro_crew.auth.bridge",
            SimpleNamespace(
                default_token_store=lambda: MagicMock(),
                vault_holds_identity=lambda: True,
            ),
        )
        monkeypatch.setitem(
            __import__("sys").modules,
            "kiro_crew.auth.provider",
            SimpleNamespace(KasAuthProvider=_Provider, NotAuthenticated=_Boom),
        )

        assert await crew_cred.crew_vault_credential() is None


# --------------------------------------------------------------------------
# The refresh: what the endpoint can answer with no kiro-cli at all.
# --------------------------------------------------------------------------


class TestRefreshWithoutKiroCli:
    @pytest.fixture(autouse=True)
    def _no_subprocess(self, monkeypatch):
        """Any spawn in these cases is a defect, so make one impossible to miss."""

        async def _forbidden(*a, **k):  # pragma: no cover - asserted by not firing
            raise AssertionError("this path must start no kiro-cli subprocess")

        monkeypatch.setattr(sessions_mod, "_fetch_whoami", _forbidden)
        monkeypatch.setattr("asyncio.create_subprocess_exec", _forbidden)

    @pytest.mark.asyncio
    async def test_a_withheld_spawn_still_publishes_crews_reading(self, monkeypatch):
        """The defect, fixed: a reading where there used to be a 503.

        The readiness gate withholds the subprocess and kiro-cli is not even
        resolved -- yet Crew's own credential answers, so the pill shows a
        balance instead of the "could not read your balance" dash.
        """
        monkeypatch.setattr(
            crew_cred, "crew_vault_credential", AsyncMock(return_value=_vault())
        )
        monkeypatch.setattr(
            crew_cred,
            "read_usage_with_crew_credential",
            AsyncMock(return_value=_api_result({"credits_plan": 10000.0, "credits_used": 42.0})),
        )
        resolve = AsyncMock(return_value="/bin/kiro")
        monkeypatch.setattr(sessions_mod, "_resolve_kiro_bin_for_spawn", resolve)

        await sessions_mod._fetch_usage_bg(allow_kiro_spawn=False)

        assert sessions_mod._usage_cache["credits_plan"] == 10000.0
        assert sessions_mod._usage_cache["credits_used"] == 42.0
        # A withheld spawn must not even resolve the binary.
        resolve.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_the_reading_carries_the_identity_crew_actually_holds(self, monkeypatch):
        """Crew performed this sign-in, so the account is a record, not a guess.

        `account` is the profile display name `fetch_usage_limits` attaches from
        the same ListAvailableProfiles probe that proved the ARN; `account_type`
        is the stored kind of the sign-in. Both reach the panel, so a balance
        read with Crew's own credential is not an anonymous number.

        `email` is absent because the vault genuinely does not hold one and no
        API reachable from here returns it -- omitted, never synthesised. The
        private coupling field must not reach the cache at all.
        """
        monkeypatch.setattr(
            crew_cred,
            "crew_vault_credential",
            AsyncMock(return_value=_vault()._replace(account_type="IamIdentityCenter")),
        )
        monkeypatch.setattr(
            crew_cred,
            "read_usage_with_crew_credential",
            AsyncMock(
                return_value=_api_result(
                    {"credits_plan": 10000.0, "account": "KIRO POWER", "_profile_arn": _ARN}
                )
            ),
        )
        monkeypatch.setattr(sessions_mod, "_resolve_kiro_bin_for_spawn", AsyncMock(return_value=None))

        await sessions_mod._fetch_usage_bg(allow_kiro_spawn=False)

        assert sessions_mod._usage_cache["account"] == "KIRO POWER"
        assert sessions_mod._usage_cache["account_type"] == "IamIdentityCenter"
        assert "email" not in sessions_mod._usage_cache
        assert "_profile_arn" not in sessions_mod._usage_cache, (
            "the private coupling field must never reach the cache"
        )

    @pytest.mark.asyncio
    async def test_the_api_outranks_our_label_for_the_credential(self, monkeypatch):
        """If the API ever names the account type, that answer wins.

        It describes the credential that was actually spent; ours describes the
        one we handed over. They agree today, and if they ever stop, the spender
        is the authority.
        """
        monkeypatch.setattr(
            crew_cred,
            "crew_vault_credential",
            AsyncMock(return_value=_vault()._replace(account_type="BuilderId")),
        )
        monkeypatch.setattr(
            crew_cred,
            "read_usage_with_crew_credential",
            AsyncMock(
                return_value=_api_result(
                    {"credits_plan": 10000.0, "account_type": "IamIdentityCenter"}
                )
            ),
        )
        monkeypatch.setattr(sessions_mod, "_resolve_kiro_bin_for_spawn", AsyncMock(return_value=None))

        await sessions_mod._fetch_usage_bg(allow_kiro_spawn=False)

        assert sessions_mod._usage_cache["account_type"] == "IamIdentityCenter"

    @pytest.mark.asyncio
    async def test_an_unlabelled_identity_publishes_no_account_type(self, monkeypatch):
        """No label is a state the panel handles; a wrong one is a false claim."""
        monkeypatch.setattr(
            crew_cred, "crew_vault_credential", AsyncMock(return_value=_vault())
        )
        monkeypatch.setattr(
            crew_cred,
            "read_usage_with_crew_credential",
            AsyncMock(return_value=_api_result({"credits_plan": 10000.0})),
        )
        monkeypatch.setattr(sessions_mod, "_resolve_kiro_bin_for_spawn", AsyncMock(return_value=None))

        await sessions_mod._fetch_usage_bg(allow_kiro_spawn=False)

        assert sessions_mod._usage_cache["credits_plan"] == 10000.0
        assert "account_type" not in sessions_mod._usage_cache

    @pytest.mark.asyncio
    async def test_an_empty_reading_names_the_remedy(self, monkeypatch):
        """An auth-class failure has to say "sign in again", not "no plan"."""
        monkeypatch.setattr(
            crew_cred, "crew_vault_credential", AsyncMock(return_value=_vault())
        )
        monkeypatch.setattr(
            crew_cred,
            "read_usage_with_crew_credential",
            AsyncMock(return_value=_api_result(None, usage_api.AUTH_REJECTED)),
        )
        monkeypatch.setattr(sessions_mod, "_resolve_kiro_bin_for_spawn", AsyncMock(return_value=None))

        await sessions_mod._fetch_usage_bg(allow_kiro_spawn=False)

        assert sessions_mod._usage_cache["available"] is False
        assert sessions_mod._usage_cache["reason"] == sessions_mod._REASON_SIGNIN_REQUIRED

    @pytest.mark.asyncio
    async def test_the_scrape_backoff_is_never_touched(self, monkeypatch):
        """No scrape ran, so nothing here may park it.

        Feeding this path's outcome into the backoff would let a Crew-credential
        problem park the kiro-cli scrape the next ready refresh depends on.
        """
        monkeypatch.setattr(
            crew_cred, "crew_vault_credential", AsyncMock(return_value=_vault())
        )
        monkeypatch.setattr(
            crew_cred,
            "read_usage_with_crew_credential",
            AsyncMock(return_value=_api_result(None, usage_api.AUTH_REJECTED)),
        )
        monkeypatch.setattr(sessions_mod, "_resolve_kiro_bin_for_spawn", AsyncMock(return_value=None))

        await sessions_mod._fetch_usage_bg(allow_kiro_spawn=False)

        assert sessions_mod._usage_scrape_failures == 0
        assert sessions_mod._usage_scrape_backoff_until == 0.0

    @pytest.mark.asyncio
    async def test_no_kiro_cli_and_no_crew_identity_is_still_unavailable(self, monkeypatch):
        """The pre-existing no-reading dash, unchanged where it was right."""
        monkeypatch.setattr(crew_cred, "crew_vault_credential", AsyncMock(return_value=None))
        monkeypatch.setattr(sessions_mod, "_resolve_kiro_bin_for_spawn", AsyncMock(return_value=None))

        await sessions_mod._fetch_usage_bg()

        assert sessions_mod._usage_cache == {"available": False}


# --------------------------------------------------------------------------
# The gate: a verdict about spawning, not about the endpoint.
# --------------------------------------------------------------------------


class TestTheEndpointNoLongerRefuses:
    def _request(self):
        request = MagicMock()
        request.app = {"state": SimpleNamespace(_background_tasks=set())}
        return request

    @pytest.mark.asyncio
    async def test_an_unverified_gateway_gets_an_answer_and_no_spawn(self, monkeypatch):
        """Both halves of the fix in one place.

        The endpoint answers 200 (so the dashboard has something true to render)
        AND the refresh it schedules is told to start no subprocess (so the
        browser-storm guarantee the 503 existed for is kept).
        """
        monkeypatch.setattr(sessions_mod, "_usage_cache_ts", 0.0)
        monkeypatch.setattr(
            sessions_mod, "kiro_spawn_allowed", AsyncMock(return_value=False)
        )
        with patch.object(sessions_mod, "_fetch_usage_bg", AsyncMock()) as fetch:
            resp = await sessions_mod.api_sessions_usage(self._request())
            await asyncio.sleep(0)

        assert resp.status == 200
        fetch.assert_called_once_with(allow_kiro_spawn=False)

    @pytest.mark.asyncio
    async def test_a_ready_gateway_still_authorizes_the_spawn(self, monkeypatch):
        monkeypatch.setattr(sessions_mod, "_usage_cache_ts", 0.0)
        monkeypatch.setattr(
            sessions_mod, "kiro_spawn_allowed", AsyncMock(return_value=True)
        )
        with patch.object(sessions_mod, "_fetch_usage_bg", AsyncMock()) as fetch:
            resp = await sessions_mod.api_sessions_usage(self._request())
            await asyncio.sleep(0)

        assert resp.status == 200
        fetch.assert_called_once_with(allow_kiro_spawn=True)
