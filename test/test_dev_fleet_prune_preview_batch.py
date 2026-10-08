"""Prune preview resolves every worktree verdict from ONE repo-wide ``gh pr
list``, so its GitHub network cost is independent of worktree count.

The preview (``_prune_candidates`` -> ``_prunable`` per worktree) classifies a
tree merged / closed / open and binds the merged/closed verdict to the PR head
OID. The verdict inputs (PR state, PR head OID) all come from GitHub, and
before the batch fetch each worktree paid its own ``gh pr list --head`` call
(one for the status, a second for the fresh head OID on a terminal verdict),
so the preview's network cost scaled O(N) with worktree count.

Everything is injected: no real git, no real subprocess, no network. Each test
counts the ``gh pr list`` invocations and asserts the count does not grow with
N, and that the per-worktree kept/candidate verdict is byte-identical to the
pre-batch meaning for merged, closed and open heads.
"""

from __future__ import annotations

import pytest

from kiro_crew.apps.builtins.dev_fleet import fleet_state, repository, worktree_ops


# --------------------------------------------------------------------------
# A fake ``gh``/git backend: records every gh pr list invocation and answers
# the few git reads the verdict path makes, with no real subprocess.
# --------------------------------------------------------------------------
class _FakeGh:
    """Stand-in for ``runtime._run_cmd`` that serves PR rows from a table.

    ``prs`` maps a head branch name to a dict with ``state`` and
    ``headRefOid``. ``gh pr list`` calls are tallied so a test can assert the
    count is independent of worktree count.
    """

    def __init__(self, prs: dict[str, dict]):
        self._prs = prs
        self.gh_pr_list_calls = 0
        # gh pr list calls that scoped to a single head via --head <branch>:
        # the per-worktree shape the batch fetch must replace.
        self.gh_pr_list_head_calls = 0

    async def run_cmd(self, cmd, timeout=None, **kw):
        if cmd[:3] == ["gh", "pr", "list"]:
            self.gh_pr_list_calls += 1
            head = None
            if "--head" in cmd:
                self.gh_pr_list_head_calls += 1
                head = cmd[cmd.index("--head") + 1]
            fields = cmd[cmd.index("--json") + 1].split(",") if "--json" in cmd else []
            if head is not None:
                rows = []
                pr = self._prs.get(head)
                if pr is not None:
                    rows.append(self._row(head, pr, fields))
            else:
                # Repo-wide list: every PR, newest first is irrelevant here.
                rows = [self._row(b, pr, fields) for b, pr in self._prs.items()]
            return (0, _json(rows), "")
        # git reads the verdict path makes.
        if cmd[:1] == ["git"]:
            if "rev-parse" in cmd:
                # HEAD oid of the worktree: use the PR head so merged/closed
                # trees pass the squash-safe containment guard.
                path = cmd[cmd.index("-C") + 1]
                branch = _branch_for_path(path)
                pr = self._prs.get(branch) or {}
                return (0, (pr.get("headRefOid") or "deadbeef") + "\n", "")
            if "merge-base" in cmd:
                return (0, "", "")  # --is-ancestor: contained
            # own-commits count / status / dirty split: clean, zero.
            return (0, "", "")
        return (0, "", "")

    def _row(self, head, pr, fields):
        full = {
            "number": 1,
            "state": pr["state"],
            "url": f"https://x/{head}",
            "isDraft": False,
            "title": head,
            "body": "",
            "headRefName": head,
            "headRefOid": pr.get("headRefOid"),
        }
        return {k: full.get(k) for k in fields} if fields else full


def _json(obj):
    import json

    return json.dumps(obj)


_PATH_TO_BRANCH: dict[str, str] = {}


def _branch_for_path(path: str) -> str:
    return _PATH_TO_BRANCH.get(path, "")


@pytest.fixture
def _pin_state(monkeypatch):
    monkeypatch.setattr(fleet_state, "_PR_CACHE", {})
    monkeypatch.setattr(fleet_state, "_OWNER_REPO", "kirodotdev/KiroCrew")
    monkeypatch.setattr(repository, "_FALLBACK_REPOS", [])
    monkeypatch.setattr(repository, "_repo", lambda: "/fake/repo")
    _PATH_TO_BRANCH.clear()


def _make_worktrees(states: dict[str, str]) -> list[dict]:
    """One worktree per branch; register its path->branch mapping."""
    wts = [{"is_main": True, "path": "/fake/repo", "branch": "main"}]
    for branch in states:
        path = f"/fake/wt/{branch}"
        _PATH_TO_BRANCH[path] = branch
        wts.append({"is_main": False, "path": path, "branch": branch})
    return wts


def _prs_from(states: dict[str, str]) -> dict[str, dict]:
    return {b: {"state": st, "headRefOid": f"oid-{b}"} for b, st in states.items()}


@pytest.mark.asyncio
async def _run_preview(monkeypatch, states: dict[str, str]) -> tuple[dict, _FakeGh]:
    fake = _FakeGh(_prs_from(states))
    monkeypatch.setattr("kiro_crew.apps.builtins.dev_fleet.runtime._run_cmd", fake.run_cmd)
    monkeypatch.setattr(
        repository,
        "_discover_worktrees",
        lambda: _async(_make_worktrees(states)),
    )
    result = await worktree_ops._prune_candidates()
    return result, fake


async def _async(v):
    return v


# --------------------------------------------------------------------------
# 1. Call count is independent of worktree count (the repro / the fix).
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_prune_preview_gh_pr_list_count_is_independent_of_worktree_count(
    monkeypatch, _pin_state
):
    small = {f"br{i}": "OPEN" for i in range(3)}
    big = {f"br{i}": "OPEN" for i in range(30)}

    _r3, fake3 = await _run_preview(monkeypatch, small)
    _r30, fake30 = await _run_preview(monkeypatch, big)

    # The whole point: 10x the worktrees must NOT mean ~10x the gh pr list
    # calls. One repo-wide list serves them all.
    assert fake3.gh_pr_list_calls == fake30.gh_pr_list_calls, (
        f"gh pr list scaled with N: 3 worktrees -> {fake3.gh_pr_list_calls}, "
        f"30 worktrees -> {fake30.gh_pr_list_calls}"
    )
    # Exactly ONE repo-wide list (no fallback repos pinned here), for any N.
    assert (
        fake30.gh_pr_list_calls == 1
    ), f"expected one repo-wide gh pr list, got {fake30.gh_pr_list_calls}"
    # No per-worktree --head fetches at all.
    assert fake30.gh_pr_list_head_calls == 0, (
        f"expected no per-worktree --head gh pr list calls, " f"got {fake30.gh_pr_list_head_calls}"
    )


# --------------------------------------------------------------------------
# 2. Verdict parity: merged / closed / open heads classify unchanged.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_prune_preview_verdict_parity_merged_closed_open(monkeypatch, _pin_state):
    states = {"merged-br": "MERGED", "closed-br": "CLOSED", "open-br": "OPEN"}
    result, _fake = await _run_preview(monkeypatch, states)

    verdicts = {}
    for row in result["candidates"]:
        verdicts[row["branch"]] = row["code"]
    for row in result["kept"]:
        verdicts[row["branch"]] = row["code"]

    # Merged clean + contained -> prunable candidate (code "merged").
    assert verdicts["merged-br"] == "merged"
    # Closed clean: the fresh head-OID check (_fetch_pr_head_oid) is
    # MERGED-gated and returns None for a CLOSED-only head, so the squash-safe
    # guard cannot verify and the tree is withheld as "closed_unverified".
    # This fail-closed verdict is the pre-batch behaviour and must not change.
    assert verdicts["closed-br"] == "closed_unverified"
    # Open PR, zero own commits, clean, fresh -> kept (not a candidate).
    assert verdicts["open-br"] in {"fresh", "active"}

    cand_branches = {r["branch"] for r in result["candidates"]}
    assert "merged-br" in cand_branches
    assert "closed-br" not in cand_branches
    assert "open-br" not in cand_branches


# --------------------------------------------------------------------------
# 3. The batched merged-head decision mirrors the per-head rule exactly:
#    reused head (MERGED + OPEN) and saturation both fail closed.
# --------------------------------------------------------------------------
def test_pr_index_merged_head_oid_matches_shared_rule():
    # A reused head carrying both a MERGED PR and an OPEN one: a MERGED OID
    # must NOT be returned (the OPEN PR is work the merged verdict ignores).
    reused = [
        {"state": "OPEN", "headRefOid": "open-oid"},
        {"state": "MERGED", "headRefOid": "merged-oid"},
    ]
    assert fleet_state._merged_head_oid_from_rows(reused) is None
    idx = fleet_state.PrIndex({"br": list(reused)})
    assert idx.merged_head_oid("br") is None

    # A clean MERGED-only head returns its OID.
    merged_only = [{"state": "MERGED", "headRefOid": "merged-oid"}]
    assert fleet_state._merged_head_oid_from_rows(merged_only) == "merged-oid"
    assert fleet_state.PrIndex({"br": merged_only}).merged_head_oid("br") == "merged-oid"

    # Saturation: more rows than the ceiling fails closed.
    saturated = [
        {"state": "MERGED", "headRefOid": f"o{i}"}
        for i in range(fleet_state._PR_HEAD_LOOKUP_LIMIT + 1)
    ]
    assert fleet_state._merged_head_oid_from_rows(saturated) is None
    assert fleet_state.PrIndex({"br": saturated}).merged_head_oid("br") is None

    # A head absent from the index is "no PR": no OID, no crash.
    assert fleet_state.PrIndex({}).merged_head_oid("missing") is None


# --------------------------------------------------------------------------
# 4. A failed/unresolved batch fetch yields a None index, so the preview
#    falls back to the per-worktree path instead of misclassifying every tree.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_build_pr_index_none_on_unresolved_repo(monkeypatch, _pin_state):
    monkeypatch.setattr(fleet_state, "_OWNER_REPO", None)
    monkeypatch.setattr(fleet_state, "_get_owner_repo", lambda: _async(None))
    assert await fleet_state._build_pr_index() is None


# --------------------------------------------------------------------------
# 5. A SATURATED index (repo has more PRs than the cap) treats a MISS as
#    unknown, not "no PR": the aged-out head is settled by a per-head fetch,
#    never silently reclassified, and the wrong None is not cached.
# --------------------------------------------------------------------------
def test_pr_index_saturation_distinguishes_hit_miss():
    present = fleet_state.PrIndex(
        {"here": [{"state": "MERGED", "headRefOid": "o"}]}, saturated=True
    )
    assert present.has("here") is True
    assert present.has("gone") is False
    assert present.saturated is True
    # The raw accessor still returns the head's row; the CONSUMERS, not the
    # index, re-verify a saturated hit per-head (see the _prunable test below).
    assert present.merged_head_oid("here") == "o"
    # A complete (unsaturated) index: a miss is genuinely no PR.
    complete = fleet_state.PrIndex({}, saturated=False)
    assert complete.has("x") is False
    assert complete.saturated is False


@pytest.mark.asyncio
async def test_build_pr_index_marks_saturated_at_cap(monkeypatch, _pin_state):
    monkeypatch.setattr(fleet_state, "_BATCH_PR_LIST_LIMIT", 2)
    full = [
        {"headRefName": "a", "state": "OPEN", "headRefOid": "oa"},
        {"headRefName": "b", "state": "MERGED", "headRefOid": "ob"},
    ]
    monkeypatch.setattr(fleet_state, "_batch_pr_list", lambda repo: _async(full))
    idx = await fleet_state._build_pr_index()
    assert idx is not None
    assert idx.saturated is True
    # A short page is NOT saturated.
    monkeypatch.setattr(fleet_state, "_batch_pr_list", lambda repo: _async(full[:1]))
    idx2 = await fleet_state._build_pr_index()
    assert idx2.saturated is False


@pytest.mark.asyncio
async def test_pr_status_cached_saturated_miss_falls_back_and_does_not_cache_none(
    monkeypatch, _pin_state
):
    # A merged PR exists for "aged" but it is OUTSIDE the batch window (a miss
    # against a saturated index). The verdict must come from the per-head
    # fetch, and the cache must not be poisoned with None.
    idx = fleet_state.PrIndex({}, saturated=True)
    merged_pr = {"state": "MERGED", "_head_oid": "oid-aged", "_repo": "r"}
    calls = {"n": 0}

    async def fake_fetch(branch):
        calls["n"] += 1
        return merged_pr if branch == "aged" else None

    monkeypatch.setattr(fleet_state, "_fetch_pr_status", fake_fetch)
    monkeypatch.setattr(
        fleet_state,
        "_head_contained_in_pr",
        lambda path, a, b: _async(True),
    )

    data = await fleet_state._pr_status_cached("aged", head_oid="oid-aged", index=idx)
    assert data is merged_pr
    assert calls["n"] == 1  # fell back to the per-head fetch
    # The MERGED verdict is cached (so it is not re-fetched), with the right head.
    assert fleet_state._PR_CACHE["aged"]["data"] is merged_pr


@pytest.mark.asyncio
async def test_pr_status_cached_complete_miss_is_no_pr_without_fetch(monkeypatch, _pin_state):
    # A miss against a COMPLETE (unsaturated) index is genuinely no PR: no
    # per-head fetch, cached as None.
    idx = fleet_state.PrIndex({}, saturated=False)
    calls = {"n": 0}

    async def fake_fetch(branch):
        calls["n"] += 1
        return None

    monkeypatch.setattr(fleet_state, "_fetch_pr_status", fake_fetch)
    data = await fleet_state._pr_status_cached("nope", head_oid="h", index=idx)
    assert data is None
    assert calls["n"] == 0  # trusted the index, no network


# --------------------------------------------------------------------------
# 6. Fallback-repo precedence: a head first seen in fallback repo A is NOT
#    re-absorbed from fallback repo B (first-matching-repo wins), so B's rows
#    cannot change A's verdict.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_build_pr_index_fallback_first_match_precedence(monkeypatch, _pin_state):
    monkeypatch.setattr(repository, "_FALLBACK_REPOS", ["org/legacy-a", "org/legacy-b"])

    pages = {
        "kirodotdev/KiroCrew": [],  # upstream has no PR for "dup"
        "org/legacy-a": [{"headRefName": "dup", "state": "MERGED", "headRefOid": "from-a"}],
        "org/legacy-b": [{"headRefName": "dup", "state": "OPEN", "headRefOid": "from-b"}],
    }

    async def fake_batch(repo):
        return pages[repo]

    monkeypatch.setattr(fleet_state, "_batch_pr_list", fake_batch)
    idx = await fleet_state._build_pr_index()
    # Only repo A's row is indexed for "dup"; repo B's OPEN row is excluded, so
    # the merged verdict from A stands (B would have withheld it).
    assert [r["_repo"] for r in idx.rows["dup"]] == ["org/legacy-a"]
    assert idx.merged_head_oid("dup") == "from-a"


# --------------------------------------------------------------------------
# 7. Saturated upstream must not let a fallback repo claim a head whose
#    upstream row aged out of the window. If it could, a legacy MERGED row
#    would mask a possibly-aged-out upstream OPEN PR; the cached legacy repo
#    would then send removal's re-check to the wrong repo and delete a live
#    worktree. The head must stay a MISS so the saturated-miss path resolves
#    it with a per-head fetch (upstream-first precedence).
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_saturated_upstream_blocks_fallback_claim(monkeypatch, _pin_state):
    monkeypatch.setattr(fleet_state, "_BATCH_PR_LIST_LIMIT", 2)
    monkeypatch.setattr(repository, "_FALLBACK_REPOS", ["org/legacy"])

    pages = {
        # Upstream page is FULL (== cap): its oldest rows are cut, so a head
        # it does not index may have aged out rather than having no upstream PR.
        "kirodotdev/KiroCrew": [
            {"headRefName": "other-1", "state": "OPEN", "headRefOid": "u1"},
            {"headRefName": "other-2", "state": "OPEN", "headRefOid": "u2"},
        ],
        # Legacy repo carries a MERGED row on a head upstream did not index.
        "org/legacy": [
            {"headRefName": "reused", "state": "MERGED", "headRefOid": "legacy-merged"},
        ],
    }

    async def fake_batch(repo):
        return pages[repo]

    monkeypatch.setattr(fleet_state, "_batch_pr_list", fake_batch)
    idx = await fleet_state._build_pr_index()

    # Upstream saturated -> no fallback absorption at all.
    assert idx.saturated is True
    assert idx.has("reused") is False  # UNKNOWN, not a trusted legacy hit
    assert idx.merged_head_oid("reused") is None
    assert "org/legacy" not in {r["_repo"] for rows in idx.rows.values() for r in rows}


# --------------------------------------------------------------------------
# 8. The gate is narrow: when the UPSTREAM page is NOT full, upstream indexed
#    every head it has, so a head absent from upstream genuinely has no
#    upstream PR and a fallback claim is correct (matches the per-head
#    upstream-first-then-fallback behaviour).
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_unsaturated_upstream_still_allows_fallback_claim(monkeypatch, _pin_state):
    monkeypatch.setattr(fleet_state, "_BATCH_PR_LIST_LIMIT", 500)
    monkeypatch.setattr(repository, "_FALLBACK_REPOS", ["org/legacy"])

    pages = {
        "kirodotdev/KiroCrew": [],  # short page: upstream is complete
        "org/legacy": [
            {"headRefName": "legacy-only", "state": "MERGED", "headRefOid": "lo"},
        ],
    }

    async def fake_batch(repo):
        return pages[repo]

    monkeypatch.setattr(fleet_state, "_batch_pr_list", fake_batch)
    idx = await fleet_state._build_pr_index()

    assert idx.saturated is False
    assert idx.has("legacy-only") is True
    assert idx.merged_head_oid("legacy-only") == "lo"
    assert idx.rows["legacy-only"][0]["_repo"] == "org/legacy"


# --------------------------------------------------------------------------
# 9. F1 deeper facet: upstream is COMPLETE, so fallback scanning runs, but the
#    FIRST fallback repo (A) comes back saturated. A later fallback repo (B)
#    must NOT claim a head A did not index -- A's owning row for that head may
#    have aged out of A's window. Traversal stops after A's saturated page, so
#    the head stays a MISS (UNKNOWN) and resolves upstream-first per-head.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_saturated_fallback_a_stops_fallback_b_claim(monkeypatch, _pin_state):
    monkeypatch.setattr(fleet_state, "_BATCH_PR_LIST_LIMIT", 2)
    monkeypatch.setattr(repository, "_FALLBACK_REPOS", ["org/legacy-a", "org/legacy-b"])

    pages = {
        "kirodotdev/KiroCrew": [],  # upstream complete -> fallback scan runs
        # Fallback A page is FULL (== cap): its oldest rows are cut, so a head
        # it does not index (here "reused") may have aged out of A's window.
        "org/legacy-a": [
            {"headRefName": "a-1", "state": "OPEN", "headRefOid": "a1"},
            {"headRefName": "a-2", "state": "OPEN", "headRefOid": "a2"},
        ],
        # Fallback B carries a MERGED row on the head A did not index. If B were
        # reached it would be trusted and cached, sending removal to B.
        "org/legacy-b": [
            {"headRefName": "reused", "state": "MERGED", "headRefOid": "b-merged"},
        ],
    }

    async def fake_batch(repo):
        return pages[repo]

    monkeypatch.setattr(fleet_state, "_batch_pr_list", fake_batch)
    idx = await fleet_state._build_pr_index()

    assert idx.saturated is True
    # B never reached: "reused" is a MISS (UNKNOWN), not a trusted B hit.
    assert idx.has("reused") is False
    assert idx.merged_head_oid("reused") is None
    assert "org/legacy-b" not in {r["_repo"] for rows in idx.rows.values() for r in rows}


# --------------------------------------------------------------------------
# 10. F2: a worktree whose head is a HIT in a SATURATED index must have its
#     merged/closed verdict resolved by the per-head fetch, NOT read from the
#     index -- cross-repo truncation can leave the index row describing the
#     wrong repo. The preview must therefore make a per-head gh pr list call
#     for that worktree even though the head is present in the index.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_prunable_reverifies_saturated_hit_per_head(monkeypatch, _pin_state):
    fake = _FakeGh(_prs_from({"feat": "MERGED"}))
    monkeypatch.setattr("kiro_crew.apps.builtins.dev_fleet.runtime._run_cmd", fake.run_cmd)
    _PATH_TO_BRANCH["/fake/wt/feat"] = "feat"

    # A saturated index that DOES contain the head (a hit).
    idx = fleet_state.PrIndex(
        {"feat": [{"state": "MERGED", "headRefOid": "oid-feat", "headRefName": "feat"}]},
        saturated=True,
    )
    assert idx.has("feat") is True  # it is a hit

    before = fake.gh_pr_list_head_calls
    await worktree_ops._prunable("/fake/wt/feat", "feat", pr_index=idx)
    # Because the index is saturated, the verdict was re-verified per-head:
    # at least one --head gh pr list call was made despite the hit.
    assert fake.gh_pr_list_head_calls > before


# --------------------------------------------------------------------------
# 11. Contrast with 10: a hit in an UNSATURATED index is trusted (read from
#     memory), so NO per-head gh pr list call is made for that worktree.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_prunable_trusts_unsaturated_hit_without_per_head(monkeypatch, _pin_state):
    fake = _FakeGh(_prs_from({"feat": "MERGED"}))
    monkeypatch.setattr("kiro_crew.apps.builtins.dev_fleet.runtime._run_cmd", fake.run_cmd)
    _PATH_TO_BRANCH["/fake/wt/feat"] = "feat"

    idx = fleet_state.PrIndex(
        {"feat": [{"state": "MERGED", "headRefOid": "oid-feat", "headRefName": "feat"}]},
        saturated=False,
    )

    before = fake.gh_pr_list_head_calls
    await worktree_ops._prunable("/fake/wt/feat", "feat", pr_index=idx)
    assert fake.gh_pr_list_head_calls == before  # no per-head call: index trusted
