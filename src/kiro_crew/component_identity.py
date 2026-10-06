"""Selected-versus-running component version skew.

Kiro Crew can *select* a new package while the running gateway keeps serving an
earlier one. The gateway stays reachable, so ordinary health reports the same
visible state whether the gateway runs the selected package or a stale one --
yet the two states need different operator action (nothing, versus finish the
update / restart the gateway). This module adds the missing *effective-state*
indicator: it compares the selected package's version against the version the
running gateway reports, surfaced as ``aligned`` or ``version_skew``.

What this module is, and is NOT:

* It is a DIAGNOSTIC. It compares two version strings the caller already holds.
  It never restarts, stops, adopts, or replaces a process, and it does not touch
  update, ownership, restart, or recovery behaviour.
* The comparable identity is the release-clamped product version
  (:func:`kiro_crew.beacon.release`). It is the stable, low-cardinality,
  cross-install (packaged *and* source) version the rest of the codebase trusts,
  so string equality on it is a meaningful "same package" test. The caller
  decides the warning threshold; this module reports skew immediately and
  exposes its age.

A gateway whose running version could not be read is passed as ``None``, so the
result is ``unknown`` rather than a fabricated alignment.

Exported shape. The result is a :class:`SkewReport`; each row is a
:class:`ComponentRow` carrying only ``role``, ``product_version``,
``build_identity`` and ``relation``. Nothing here carries an installation path,
hostname, command line, username, or process identifier.
:func:`ComponentRow.as_dict` is the ONLY serialization and it emits exactly
those four fields, so a caller cannot accidentally export a leaky attribute.

Mismatch age. The age is "how long has *this* skew been observed", not "how old
is the stale process", because the operator question is whether the mismatch is
a transient update window or a persistent one. The first time a skew is seen a
marker is written under ``config_dir()``; the age is ``now - marker``. An
aligned result clears the marker, so a later skew starts a fresh clock. The
marker is best-effort: an unwritable config dir yields age ``0.0`` rather than
failing the comparison.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Optional

from kiro_crew import __version__, beacon
from kiro_crew.atomic_write import atomic_write
from kiro_crew.config.paths import config_dir

logger = logging.getLogger(__name__)

# Role names for the two rows the report carries.
SELECTED_ROLE = "selected"
GATEWAY_ROLE = "gateway"

# Relations a running component can bear to the selected package.
REL_SELECTED = "selected"
REL_ALIGNED = "aligned"
REL_SKEWED = "skewed"
REL_UNKNOWN = "unknown"

# Overall results.
RESULT_ALIGNED = "aligned"
RESULT_SKEW = "version_skew"

# Persisted first-seen marker for mismatch age.
_SKEW_MARKER_FILE = "component-skew-first-seen.json"


@dataclass(frozen=True)
class ComponentRow:
    """One exported row: the selected package or the running gateway.

    The ONLY serialization is :meth:`as_dict`, which emits exactly the four
    public fields. There is deliberately no field for a path, hostname, command
    line, username, or PID, so none can be exported.
    """

    role: str
    product_version: str
    build_identity: str
    relation: str

    def as_dict(self) -> dict:
        return {
            "role": self.role,
            "product_version": self.product_version,
            "build_identity": self.build_identity,
            "relation": self.relation,
        }


@dataclass(frozen=True)
class SkewReport:
    """Result of comparing the selected package against the running gateway."""

    #: :data:`RESULT_ALIGNED`, :data:`RESULT_SKEW`, or ``unknown``.
    result: str
    #: Human-readable, bounded reason (never carries a leaky identifier).
    reason: str
    #: Seconds since this skew was first observed; ``0.0`` when not skewed.
    mismatch_age_seconds: float
    #: The selected-package row followed by the gateway row.
    rows: tuple[ComponentRow, ...]

    def as_dict(self) -> dict:
        return {
            "result": self.result,
            "reason": self.reason,
            "mismatch_age_seconds": self.mismatch_age_seconds,
            "components": [r.as_dict() for r in self.rows],
        }


def selected_version() -> str:
    """Full version of the package this install has *selected*.

    This is the local package the running CLI module itself came from -- the
    reference the gateway's running version is compared against. The comparison
    uses the FULL version so two distinct builds that merely clamp to the same
    public release (e.g. different nightlies) are not mistaken for one package.
    """
    return __version__


def _skew_marker_path():
    return config_dir() / _SKEW_MARKER_FILE


def _read_first_seen() -> Optional[float]:
    try:
        raw = _skew_marker_path().read_text(encoding="utf-8")
        value = json.loads(raw).get("first_seen")
        return float(value) if isinstance(value, (int, float)) else None
    except (OSError, ValueError):
        return None


def _write_first_seen(when: float) -> None:
    try:
        path = _skew_marker_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        # atomic_write replaces the target via temp-file + rename, so a
        # pre-planted symlink at the marker path is overwritten rather than
        # followed to clobber whatever it points at.
        atomic_write(path, json.dumps({"first_seen": when}))
    except OSError as exc:
        logger.debug("could not persist skew first-seen marker: %s", exc)


def _clear_first_seen() -> None:
    try:
        _skew_marker_path().unlink()
    except OSError:
        pass


def _mismatch_age(now: float) -> float:
    """Seconds since the current skew was first observed.

    Persists a first-seen marker so the age is meaningful across separate
    ``status`` invocations (a transient update window versus a persistent skew).
    Best-effort: an unwritable config dir yields ``0.0`` rather than raising.
    """
    first = _read_first_seen()
    if first is None or first > now:
        _write_first_seen(now)
        return 0.0
    return max(0.0, now - first)


def compare_gateway(
    gateway_version: Optional[str],
    *,
    now: Optional[float] = None,
    _selected: Optional[str] = None,
) -> SkewReport:
    """Compare the selected package against the running gateway's version.

    ``gateway_version`` is the version the live gateway reports (e.g. the
    ``/api/status`` ``version``). ``None`` or an empty string means the gateway's
    running version could not be read, which yields an ``unknown`` result rather
    than a fabricated alignment. The selected version comes from
    :func:`selected_version` (overridable via ``_selected`` for tests).

    The result is :data:`RESULT_SKEW` when the gateway's FULL version differs
    from the selected one, :data:`RESULT_ALIGNED` when they match, and
    ``unknown`` when the gateway version could not be read. The equality test is
    on the full version so two distinct builds that clamp to the same public
    release are not mistaken for the same package; ``product_version`` shows the
    release-clamped public version for display, and ``build_identity`` carries
    the full version that the comparison actually turns on.
    """
    clock = time.time() if now is None else now
    selected = _selected if _selected is not None else selected_version()
    selected_row = ComponentRow(
        role=SELECTED_ROLE,
        product_version=beacon.release(selected),
        build_identity=selected,
        relation=REL_SELECTED,
    )

    if not gateway_version:
        # The gateway's running version is unknown, not known-different: report
        # unknown and do not touch the skew clock.
        gateway_row = ComponentRow(
            role=GATEWAY_ROLE,
            product_version=REL_UNKNOWN,
            build_identity=REL_UNKNOWN,
            relation=REL_UNKNOWN,
        )
        return SkewReport(
            result=REL_UNKNOWN,
            reason="the running gateway did not report a version",
            mismatch_age_seconds=0.0,
            rows=(selected_row, gateway_row),
        )

    if gateway_version == selected:
        _clear_first_seen()
        gateway_row = ComponentRow(
            role=GATEWAY_ROLE,
            product_version=beacon.release(gateway_version),
            build_identity=gateway_version,
            relation=REL_ALIGNED,
        )
        return SkewReport(
            result=RESULT_ALIGNED,
            reason="the running gateway serves the selected package",
            mismatch_age_seconds=0.0,
            rows=(selected_row, gateway_row),
        )

    age = _mismatch_age(clock)
    gateway_row = ComponentRow(
        role=GATEWAY_ROLE,
        product_version=beacon.release(gateway_version),
        build_identity=gateway_version,
        relation=REL_SKEWED,
    )
    return SkewReport(
        result=RESULT_SKEW,
        reason="the running gateway serves a package other than the selected one",
        mismatch_age_seconds=age,
        rows=(selected_row, gateway_row),
    )
