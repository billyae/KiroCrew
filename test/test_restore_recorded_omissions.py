"""``restore --mode replace`` must not turn a bundle's recorded omissions into deletions.

Snapshot tolerates an entry it cannot read: the entry is left out and named in
``MANIFEST.json``'s ``skipped`` list. Replace clears each component's live tree before
installing the bundle's copy, so when the entry has become readable by restore time the
live file leaves the data home, survives only in ``pre-restore-<ts>/``, and the run
reported success. Replace now refuses such a bundle unless ``--allow-omissions`` is given;
merge, which clears nothing, is unchanged.

The chain is reproduced end to end rather than with a hand-written manifest: the snapshot
runs with the file denied (the same syscall interception the snapshot-side suite uses),
the denial is lifted, and the restore runs against the live home.
"""

from __future__ import annotations

import errno
import io
import json
import os
import tarfile

import pytest
from test_snapshot import _setup_fake_kirocrew, unpinnable_argv

from kiro_crew import pinned_fs
from kiro_crew import snapshot as snap

VICTIM = "omitted-victim.md"
PINNED_TREE_WALK = pinned_fs.supports_pinned_tree_walk()


@pytest.fixture
def home(tmp_path, monkeypatch):
    d = tmp_path / "home"
    d.mkdir()
    monkeypatch.setenv("KIROCREW_HOME", str(d))
    monkeypatch.setenv("KIROCREW_ASSUME_GATEWAY_RUNNING", "0")
    _setup_fake_kirocrew(d)
    (d / "skills" / "my-skill" / VICTIM).write_text("only copy\n")
    return d


def _snapshot_with_victim_denied(home, out) -> object:
    """Take a skills snapshot while every access to VICTIM fails, then lift the denial."""
    real = {"stat": os.stat, "lstat": os.lstat, "open": os.open}

    def _denied(path) -> bool:
        if isinstance(path, int):
            return False
        text = os.fsdecode(path)
        if os.path.basename(text) != VICTIM:
            return False
        return not os.path.dirname(text) or text.startswith(str(home))

    def _deny(key):
        def _fn(path, *args, **kwargs):
            if _denied(path):
                raise PermissionError(errno.EPERM, "Operation not permitted", str(path))
            return real[key](path, *args, **kwargs)

        return _fn

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(pinned_fs, "supports_pinned_tree_walk", lambda: PINNED_TREE_WALK)
        for key in real:
            mp.setattr(os, key, _deny(key))
        rc = snap.snapshot_main(
            [str(out), "--components", "skills", *unpinnable_argv()]
        )
    assert rc == 0
    (tarball,) = sorted(out.glob("kirocrew-*.tar.gz"))
    return tarball


def _manifest(tarball) -> dict:
    with tarfile.open(str(tarball)) as tar:
        (member,) = [m for m in tar.getmembers() if m.name.endswith("/MANIFEST.json")]
        return json.loads(tar.extractfile(member).read().decode("utf-8"))


@pytest.fixture
def bundle(home, tmp_path):
    tarball = _snapshot_with_victim_denied(home, tmp_path / "out")
    # The premise of the issue, asserted so the test fails loudly if snapshot stops
    # recording the omission rather than passing for the wrong reason.
    assert _manifest(tarball)["skipped"] == [
        {"reason": "unreadable_entry", "path": f"skills/my-skill/{VICTIM}"}
    ]
    return tarball


def _restore(tarball, *extra):
    return snap.restore_main([str(tarball), "--force", *extra, *unpinnable_argv()])


class TestReplaceRefusesABundleWithRecordedOmissions:
    def test_replace_is_refused_and_the_live_file_stays(self, home, bundle, capsys):
        rc = _restore(bundle, "--mode", "replace")
        out = capsys.readouterr().out
        assert rc == 1
        assert (home / "skills" / "my-skill" / VICTIM).read_text() == "only copy\n"
        assert "omits 1 entry" in out
        assert f"skills/my-skill/{VICTIM}" in out
        assert "--allow-omissions" in out
        assert not list(home.glob("pre-restore-*")), (
            "a refusal must not start a rollback set"
        )

    def test_dry_run_gives_the_same_answer(self, home, bundle, capsys):
        assert _restore(bundle, "--mode", "replace", "--dry-run") == 1
        assert "omits 1 entry" in capsys.readouterr().out

    def test_allow_omissions_replaces_and_names_the_cost(self, home, bundle, capsys):
        rc = _restore(bundle, "--mode", "replace", "--allow-omissions")
        out = capsys.readouterr().out
        assert rc == 0
        # The contract the flag opts into: replace still means replace.
        assert not (home / "skills" / "my-skill" / VICTIM).exists()
        (rollback,) = list(home.glob("pre-restore-*"))
        assert (rollback / "skills" / "my-skill" / VICTIM).read_text() == "only copy\n"
        assert "--allow-omissions: 1 omitted path(s)" in out

    def test_merge_is_unaffected(self, home, bundle):
        assert _restore(bundle, "--mode", "merge") == 0
        assert (home / "skills" / "my-skill" / VICTIM).read_text() == "only copy\n"


def _rewrite_skipped(tarball, skipped) -> None:
    """Rewrite the bundle's manifest ``skipped`` field in place."""
    with tarfile.open(str(tarball)) as tar:
        members = [(m, tar.extractfile(m).read() if m.isfile() else None) for m in tar]
    with tarfile.open(str(tarball), "w:gz") as tar:
        for m, data in members:
            if m.name.endswith("/MANIFEST.json"):
                doc = json.loads(data.decode("utf-8"))
                doc["skipped"] = skipped
                data = json.dumps(doc).encode("utf-8")
                m.size = len(data)
            tar.addfile(m, io.BytesIO(data) if data is not None else None)


class TestWhichOmissionsCount:
    """The predicate behind the refusal, enumerated over every shape a manifest can carry."""

    @pytest.mark.parametrize(
        ("skipped", "refused"),
        [
            # Screened by design: the bundle lacks nothing the operator asked for.
            ([{"reason": "symlink", "path": "skills/my-skill/x"}], False),
            ([{"reason": "not_regular", "path": "skills/my-skill/x"}], False),
            # Every reason that means "asked for and not carried" counts, by class.
            ([{"reason": "vanished", "path": "skills/my-skill/x"}], True),
            ([{"reason": "too_large", "path": "skills/my-skill/x"}], True),
            ([{"reason": "identity_changed", "path": "skills/my-skill/x"}], True),
            (
                [
                    {
                        "reason": "a-reason-from-a-newer-build",
                        "path": "skills/my-skill/x",
                    }
                ],
                True,
            ),
            # A Windows bundle records its own separator.
            ([{"reason": "unreadable_entry", "path": "skills\\my-skill\\x"}], True),
            # Outside the component being restored: not this restore's concern.
            ([{"reason": "unreadable_entry", "path": "workspace/notes.md"}], False),
            # Claimed by no component: cannot be placed, so it is not assumed safe.
            ([{"reason": "unreadable_entry", "path": "somewhere-new/x"}], True),
            # Unreadable declarations fail closed.
            (["not-an-object"], True),
            ("not-a-list", True),
            ([], False),
            (None, False),
        ],
    )
    def test_skills_replace(self, home, bundle, skipped, refused):
        _rewrite_skipped(bundle, skipped)
        rc = _restore(bundle, "--mode", "replace", "--dry-run")
        assert rc == (1 if refused else 0)
