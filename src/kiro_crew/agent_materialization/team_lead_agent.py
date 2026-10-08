"""The team-lead crewmate spec: the one generated agent that both leads and works.

Its own module because it shares neither sibling's shape. Every conductor spec in
:mod:`conductor_agents` overwrites the template's tool list with a literal that
withholds ``fs_write`` and ``code``, which is what makes "never does a work item's
work itself" true against the tool list rather than only against the charter. The
dispatched worker in :mod:`worker_agent` keeps the writers and mirrors the default
spec on disk, but an ``opt_in`` set is assigned per agent, so that installer
deliberately strips ``kirocrew-dashboard`` from the mirror and a worker cannot
dispatch at all.

This spec is the union those two leave empty: the template's whole toolset, so a
small focused item it keeps for itself is one it can finish, plus session control
and the work ledger, so everything else is a fleet it dispatches, patrols and
decides for.

EVERY path that writes this spec's filename, and the one invariant each is held
to: never write there when the existing content was not written by this
installer, whether or not that content parses.

* :func:`_install_team_lead_agent` is the only writer in this package, and the
  only one that replaces the file WHOLE with nothing carried forward. Three
  callers reach it and all three are the same function -- the boot rebuild, the
  hourly retry of held specs, and ``kirocrew setup --agent-only --clean`` -- so
  the attribution in one place covers all of them.
* Two shared sweeps edit an owned spec IN PLACE rather than replacing it: the
  retired-key repair that walks ``OWNED_KIRO_AGENT_FILES`` in ``agent.py``, and
  the Playwright convergence in ``browser/setup.py``. Both are keyed on the
  filename rather than on provenance, which is a property every owned spec has
  shared since before this one existed; neither discards a file, and changing
  that shape for one filename is not this installer's to do.

The spec is half of the capability, and the half it is not is worth stating here
rather than leaving to the charter. Driving the owner's dynamic dashboard needs
``dashboard_fields`` / ``dashboard_write``, those verbs resolve the calling crew
from the SESSION and not from an argument, and the server behind them is
``opt_in`` with no spec allowed to emit it at all
(``members.member_panel_session_server``). So they answer in a crewmate's own
thread and nowhere else: a spec cannot confer that on itself, and this installer
does not pretend to. What the spec carries is everything that works without it.
"""

from __future__ import annotations

import enum
import os
from pathlib import Path
from typing import Any

from kiro_crew import agent as agent_mod
from kiro_crew import agent_discovery, agent_state
from kiro_crew.agent_files import TEAM_LEAD_AGENT_FILENAME as _TEAM_LEAD_AGENT_FILENAME
from kiro_crew.agent_materialization import auto_approve, conductor_agents, managed_mcp

#: This spec's agent NAME, and also the key its lineage is recorded under: kiro-cli
#: resolves an agent by reading ``<agents dir>/<name>.json``, and ``agent_state`` keys
#: a template's fork record by that same name, so the filename and the record share
#: one string by construction rather than by a second spelling.
_TEAM_LEAD_AGENT_NAME = Path(_TEAM_LEAD_AGENT_FILENAME).stem


def _team_lead_mcp_servers(config: dict[str, Any]) -> dict[str, Any]:
    """The template's own ``mcpServers`` map plus this spec's two explicit assignments.

    ADDITIVE, where :func:`conductor_agents._conductor_mcp_servers` is subtractive,
    and the difference follows from the charter: a conductor keeps ``kirocrew-core``
    and drops the rest because it does no work, while this agent runs a build and
    drives git, so a server the template assembles is a server its own half of the
    charter may need.

    Nothing is stripped on the way through, and that is safe for a reason the
    worker installer cannot claim: this builds from ``build_agent_config`` -- Crew's
    own template -- and never mirrors the default spec on disk, so an ``opt_in`` set
    an operator mounted on their personal agent is not here to inherit.

    ``kirocrew-dashboard`` and ``kirocrew-work`` are hand-built because both are
    ``opt_in``: neither spec-writing loop emits one, and this installer naming them
    IS the explicit per-agent assignment such a set requires. The dashboard entry
    carries the two fields a copy forgets -- without ``"type": "registry"`` a
    registry-mode client silently DROPS it, so the granted session-control tools
    never launch and the dispatch half of this charter is dead with no local error;
    without the ``KIROCREW_HOME`` pin the shim reads the default data home while the
    gateway runs under an override, so dispatch would act on a different session
    store than the one it reports on. Both helpers return empty on a default
    install, so the emitted spec is unchanged there.
    """
    mcp = dict(config.get("mcpServers") or {})
    dash_cmd, dash_args = agent_mod._kirocrew_mcp_invocation("mcp-dashboard")
    dash_entry: dict[str, Any] = {"command": dash_cmd, "args": dash_args}
    if managed_mcp._mcp_registry_mode():
        dash_entry["type"] = managed_mcp._MCP_REGISTRY_TYPE
    dash_env = managed_mcp._managed_mcp_env()
    if dash_env:
        dash_entry["env"] = dash_env
    mcp["kirocrew-dashboard"] = dash_entry
    mcp["kirocrew-work"] = managed_mcp._managed_opt_in_entry("mcp-work")
    return mcp


#: The grant tuples this spec ships, in the order they are appended. Every name is
#: an existing tuple reused VERBATIM, so this installer introduces no grant name of
#: its own -- which is the strongest answer to a reviewer asking what a new
#: auto-approve widens, and it keeps each tuple's own invariant comment as the
#: justification rather than restating it here.
#:
#: ``_CONDUCTOR_CORE_GRANTS`` is the patrol loop's own lifecycle, the capacity reads
#: this charter uses instead of holding a session count, the durable store it
#: resumes a goal from, skill lookup for seeding a child, and the person-facing
#: reports. ``_CONDUCTOR_DASHBOARD_GRANTS`` is the create-and-read half of session
#: control, and the half this spec may grant: the three verbs that MUTATE a peer
#: session stay out, because they are earned by an ownership fence a spec does not
#: have -- ``authorize_target`` refuses a MEMBER caller on any session it did not
#: itself create, and a crewmate's own thread is granted them from that fence at
#: session establishment rather than from here. ``_LEDGER_CONDUCTOR_WORK_GRANTS``
#: is the ledger every dispatched item is recorded in, plus ``work_brief``, whose
#: cost the tuple's own comment states: a nested lead's mandated FIRST call, in a
#: child session nobody opened, is an approval stall before any planning happens.
#:
#: Three tuples, and ``_WORKER_WORK_GRANTS`` is deliberately not a fourth. It would
#: contribute exactly one verb this list does not already hold -- ``work_report`` --
#: and that verb is withheld from every conductor on a rule its own tuple states:
#: it WRITES into the parent's record, across a dispatch relationship. The crewmate
#: is the root of its own goal and has no parent to report to, so the grant would
#: widen an auto-approve across a trust boundary for a call that never comes.
_TEAM_LEAD_SHIPPED_GRANTS: tuple[tuple[str, ...], ...] = (
    agent_mod._CONDUCTOR_CORE_GRANTS,
    agent_mod._CONDUCTOR_DASHBOARD_GRANTS,
    agent_mod._LEDGER_CONDUCTOR_WORK_GRANTS,
)


#: The two servers that together ARE the leading half of this agent, and so the
#: provenance marks :func:`_foreign_team_lead_spec_reason` reads. Every release that
#: writes this spec writes both, by construction rather than by convention: without
#: ``kirocrew-dashboard`` it cannot dispatch and without ``kirocrew-work`` it cannot
#: record what it dispatched, and either absence makes the charter false.
_DEFINING_SERVERS: tuple[str, ...] = ("kirocrew-dashboard", "kirocrew-work")


class InstallOutcome(enum.Enum):
    """What one install attempt did to the spec on disk.

    Three values because a rebuild asks two different questions of a file it did
    not write: may a tightened ceiling be marked as projected onto the grants
    there (no, for either non-write), and is another attempt worth making (only
    for ``HELD``). Collapsing them into one boolean is what turns a deliberate,
    permanent decline into a retry that runs forever.
    """

    WRITTEN = "written"
    HELD = "held"
    DECLINED = "declined"


def _foreign_team_lead_spec_reason(spec: dict[str, Any] | None) -> str | None:
    """Why *spec*, read from this installer's path, is not its own, or ``None``.

    PROVENANCE, not existence, taking
    ``worker_agent._foreign_worker_spec_reason``'s rule: a file at this path the
    installer did not write is not an out-of-date spec, and replacing it destroys
    whatever put it there. The spec id makes a collision unlikely rather than
    impossible, so the guard is what covers the operator who happens to hold a
    hand-authored agent at this name.

    Takes a parsed object, or ``None`` for an ABSENT path. ``None`` -- "ours to
    write" -- is the only state that writes without a name to check, and a file that
    is present and does not parse never reaches here: the caller declines it on
    :data:`_UNATTRIBUTABLE`, because unreadable bytes at this name are still
    somebody's.

    The marks are the declared ``name`` and an ``mcpServers`` entry for each of
    :data:`_DEFINING_SERVERS` -- the shape THIS release writes, and only that one.
    A looser test that also accepted the reference from ``tools`` or a per-tool
    grant was considered and dropped: there is no earlier release of this spec to
    heal, so the leniency would have bought nothing and widened what counts as
    this installer's own file.

    The bound is worth stating exactly, because the marks do not carry it alone.
    Neither mark is a secret, so a file holding both is indistinguishable BY CONTENT
    from this installer's own output. Two different files reach that description and
    they are not the same case:

    * a DELIBERATE forge, which volunteers the forger's own file and costs them only
      what they chose to lose;
    * a crew's PRIVATE COPY, which arrives at both marks with nobody choosing
      anything. A copy is named after the crew that owns it and its declared ``name``
      is set equal to that stem, so a crew named for this agent lands a file declaring
      this agent's name; copy a conductor and that file mounts both
      :data:`_DEFINING_SERVERS` too, because every conductor spec mounts them.

    What separates those two is not a mark but whether anything RECORDS the file as
    somebody else's, which no spec field can carry and no copy can fake. So this
    function is the narrower SECOND question: :func:`_attribution_reason` asks
    :func:`_recorded_fork_reason` first and reaches the marks only for a file no
    record claims.

    What the marks alone still rule out is the reverse -- an ordinary crew, with its
    own charter and its own servers, being read as this spec because it occupies the
    filename.
    """
    if not isinstance(spec, dict):
        return None
    declared = spec.get("name")
    if declared != "kirocrew-team-lead":
        return f"it declares the agent name {declared!r}"
    # Shape-checked before it is read, not only its members: a hand-edited
    # ``"mcpServers": 1`` would otherwise raise out of an attribution, which
    # reaches the installer's caller as an error rather than as a declined write.
    servers = spec.get("mcpServers")
    if not isinstance(servers, dict):
        return "it declares no mcpServers map"
    for server in _DEFINING_SERVERS:
        if server not in servers:
            return f"it does not mount the {server} server this agent leads through"
    return None


def _recorded_fork_reason() -> str | None:
    """Why this installer's name holds a crew's private copy, or ``None``.

    The one signal the bytes cannot carry. A private copy is recorded in the lineage
    sidecar when it is published -- Crew writes ``forked_from`` / ``private_to``
    there because a spec file cannot hold them (kiro-cli rejects unknown fields) --
    so the record says whose the file is where the marks only say what shape it has.

    Reachable for a copy published BEFORE this stem became an owned filename.
    ``fork_publish`` counts every ``OWNED_KIRO_AGENT_FILES`` stem as taken, so no new
    copy lands here while that list holds this one; a record at this name is what
    remains of one that landed while the name was still free.

    Read STRICT, so an unreadable sidecar raises the reader's transient class and the
    caller HOLDS rather than writes. Degrading it to "no record" is the hole this
    closes: one failed read in the gap would be indistinguishable from a file nobody
    claims, and the copy would be replaced on that guess.
    """
    try:
        fork = agent_state.get_fork_info(_TEAM_LEAD_AGENT_NAME, strict=True)
    except (OSError, ValueError) as exc:
        raise conductor_agents._SpecUnusable(
            f"the lineage sidecar could not be read to tell whether this name holds a"
            f" crew's private copy ({exc}); the file may be that copy",
            replace=False,
        ) from exc
    if fork is None:
        return None
    return (
        f"the lineage sidecar records it as {fork['private_to']!r}'s private copy of"
        f" {fork['forked_from']!r}"
    )


def _attribution_reason(spec: dict[str, Any] | _Unattributable | None) -> str | None:
    """Why the file at this installer's path is not its own to replace, or ``None``.

    The WHOLE attribution, and the order is the invariant: the record before the
    marks. The marks describe the shape this release writes and the fork feature can
    put that shape on a crew's file innocently, so a recorded copy has to be rejected
    before any mark test gets the chance to accept it.

    Raises the reader's transient class when the lineage sidecar cannot be read, which
    the caller turns into a HOLD, for the same reason the spec read does: a check that
    could not run is not a check that passed.
    """
    if isinstance(spec, _Unattributable):
        return "its bytes are not a spec this installer can attribute to anyone"
    if spec is None:
        # ABSENT: the one state with nothing to destroy, and so the one that writes
        # without a name to check. A record naming this name with no file at it has no
        # bytes to keep, and the publish that records lineage before its destination
        # file exists passes through exactly this state.
        return None
    return _recorded_fork_reason() or _foreign_team_lead_spec_reason(spec)


def _managed_team_lead_install_lands(path: Path) -> bool:
    """Would the managed install WRITE at *path* -- does this installer own that file?

    The fail-closed companion to :func:`_attribution_reason`, for the callers that must
    never read a crew's file as machine-maintained: fork governance deciding it may
    SKIP a spec because an owned writer re-filters its grants every rebuild, the owned
    ORIGIN test behind a plumbing refresh, and the capability-parent classification.

    Those callers ask "is this confirmed OURS?", so every uncertain answer is False.
    An ABSENT file is confirmed as nothing -- the installer does write there, but no
    fork's grants are maintained by a file that does not exist -- and a read that
    failed transiently is not a confirmation either. The installer keeps its own
    three-way answer, where absent WRITES and a transient failure HOLDS; collapsing
    both into this predicate is what would turn a hold into a skip.
    """
    try:
        existing = _existing_spec_for_attribution(path)
        if existing is None:
            return False
        return _attribution_reason(existing) is None
    except conductor_agents._SpecUnusable:
        return False


#: The servers this spec grants VERB BY VERB. A bare ``@server`` entry for one of
#: them is dropped from the assembled list, and that subtraction is what makes the
#: narrowing real rather than cosmetic.
_VERB_GRANTED_SERVERS: frozenset[str] = frozenset(
    {"@kirocrew-core", "@kirocrew-dashboard", "@kirocrew-work"}
)


def _narrow_whole_server_grants(granted: list[str]) -> list[str]:
    """Drop a bare ``@server`` grant for a server granted verb by verb.

    The template auto-approves ``@kirocrew-core`` as a WHOLE SERVER, and this
    installer appends to the template's list rather than replacing it, so without
    this pass the named verbs would sit beside a wildcard that already covers every
    verb on that server -- ``task_run``, ``workflow_run``, ``spawn_run`` and the rest
    included. The per-verb list would then describe a narrowing the emitted spec
    does not have.

    Worse than cosmetic, and the conductor spec's own comment names the mechanism:
    both backends resolve a whole-server reference before the per-tool one, so a
    bare entry "would have survived the filter on the KAS backend" -- a verb the
    governance ceiling strips from the named list is still reached through the
    wildcard, and the ceiling's decision is silently undone.

    Subtractive and ordered LAST of the grant passes, exactly as the worker
    installer subtracts scheduling from its own assembled list, so it applies to
    every source at once: the template's entry, the appended tuples, and anything a
    later tuple adds. Only an EXACT ``@server`` match is dropped -- a per-verb entry
    on the same server is what this keeps.
    """
    return [ref for ref in granted if ref not in _VERB_GRANTED_SERVERS]


class _Unattributable:
    """A file is PRESENT at the spec's name and cannot be attributed to anyone.

    Its own type rather than ``None``, because the two answers lead to opposite
    actions and sharing one value is what let a write through once already:
    ``None`` means there is nothing at this path, which is the only state in which
    this installer writes without a name to check, while this means there IS
    something and its bytes do not say whose it is.
    """


#: The one instance; compared by identity.
_UNATTRIBUTABLE = _Unattributable()


def _readable_object_at(path: Path) -> dict[str, Any] | _Unattributable | None:
    """The JSON object at *path* for ATTRIBUTION only.

    Asked after the hardened reader has already answered ``replace=True``, and it
    answers a narrower question than that reader does: not "is this a spec this
    release can use", but "is there a readable JSON object here at all". Those
    differ in exactly the case that matters -- a document that parses and is then
    rejected on grant shape is still somebody's file, and attribution has to see
    it.

    Read through the same hardened reader (``read_agent_spec_strict``), so the
    no-follow path fence, the size cap and the sensitive-target refusal all still
    apply; what this drops is only the shape verdict layered on top of it.

    A failure here is sorted into the reader's OWN two classes rather than
    collapsed, because the two call for opposite answers:

    * a plain ``OSError`` is a read that MAY succeed next time -- a permission, an
      I/O error, a refused open. Collapsing it to "nothing to attribute" is a hole
      the size of the whole guard: a file that parsed a moment ago, and so is
      somebody's, would be attributed against nothing and overwritten because one
      read in the gap failed. It is raised as the reader's transient class, which
      the caller turns into a HOLD, and a hold costs one rebuild.
    * a ``ValueError`` is the content not being a spec, and a re-read will not
      change that. :data:`_UNATTRIBUTABLE`, so the caller DECLINES: a file with one
      missing brace is the ordinary result of a hand edit, and its bytes are the
      operator's whether or not they parse.

    Declining a file that cannot be made into a spec does not strand this agent,
    which is what makes the trade here different from ``worker_agent``'s. That spec
    is DERIVED from the default and re-checked before every worker session, so
    refusing it would break dispatch with no way out. This one is optional and
    selected by name, exactly like the dashboard-author spec, and it follows that
    spec's documented contract: the file is left untouched, no backup is written,
    and the agent stays unselectable under this name until the operator removes or
    renames it.

    An ABSENT file is the one ``None``, and the only state in which the caller
    writes without a name to check. ``FileNotFoundError`` is an ``OSError`` so it is
    caught first, and a name that still exists behind that error is a dangling link
    -- present, with nothing to attribute.
    """
    try:
        data = agent_discovery.read_agent_spec_strict(
            path, operation="team_lead_spec_attribution", source="unknown"
        )
    except FileNotFoundError:
        return _UNATTRIBUTABLE if os.path.lexists(path) else None
    except OSError as exc:
        raise conductor_agents._SpecUnusable(
            f"its bytes could not be read for attribution ({exc}); they may be your" " intact spec",
            replace=False,
        ) from exc
    except ValueError:
        return _UNATTRIBUTABLE
    return data if isinstance(data, dict) else _UNATTRIBUTABLE


def _existing_spec_for_attribution(path: Path) -> dict[str, Any] | _Unattributable | None:
    """The spec on disk at *path* to attribute before writing.

    One reader for the installer, so the transient class has ONE answer however it
    is reached. ``_spec_to_replace`` decides whether this release can USE the file;
    when it answers "no, and the bytes will not improve" (``replace=True``), the
    narrower attribution read runs, because that verdict includes a document that
    parsed. Either read raising the transient class propagates it, and the caller
    holds.

    ``None`` means the path is ABSENT, which is the only state in which this
    installer writes without a name to check. A file that is present and cannot be
    attributed answers :data:`_UNATTRIBUTABLE` instead, and the caller declines it.
    """
    try:
        return conductor_agents._spec_to_replace(path)
    except conductor_agents._SpecUnusable as exc:
        if not exc.replace:
            raise
        return _readable_object_at(path)


def _install_team_lead_agent(*, clean: bool = False) -> InstallOutcome:
    """Generate and install the kirocrew-team-lead agent config.

    The template PLUS session control PLUS the work ledger, and the first of those
    three is the one that matters: ``fs_write``, ``code``, ``grep``, ``glob`` and
    shell arrive because this installer never overwrites ``config["tools"]`` with a
    literal, the way each conductor installer does. So the charter's do-it-yourself
    half is true against the emitted spec and not only against its prose, and the
    gap this agent exists to close -- a conductor handed a one-file fix cannot make
    it, and a worker handed a goal cannot split it -- is closed in the tool list.

    ``fs_write`` needs no grant to be mounted and gets none: it is in the template's
    ``tools`` and absent from its ``allowedTools``, which is the default agent's own
    posture and the one a reviewer can check against. ``execute_bash`` is the same,
    for the reason the conductor installers record: ``allowedTools`` is name-scoped
    with no argument matching, so trusting the bundled acceptance evaluator cannot be
    told apart from trusting arbitrary shell. The charter's answer is to batch those
    calls, not to widen the grant.

    ``clean`` is accepted for one reason: every installer in this package takes it,
    and the rebuild passes it to each. It changes nothing here, because nothing on
    the previous file is carried forward -- the spec is a pure function of the
    template, the charter and the tuples above, so there is no user entry to drop.
    The conductor specs merge the user's own grants under a provenance table and
    need the flag; this one has no such merge to reset.

    Returns an :class:`InstallOutcome`, and the THREE values are the point: a
    rebuild needs to tell a list it re-derived from one it left alone, and among
    the ones it left alone it needs to tell a hold that may clear from a decline
    that never will.

    ``HELD`` is a read that failed in the reader's transient class. Retrying is
    exactly right: the same read a moment later is what clears an I/O error.

    ``DECLINED`` is a spec this installer did not write
    (:func:`_foreign_team_lead_spec_reason`). Retrying is exactly wrong. The file
    will still be somebody else's on the next pass and on every pass after it, so
    counting it as held puts the install in a retry set it can never leave --
    every hourly sweep re-running a full rebuild and logging a spec that "could
    not be written", for a decision this installer made on purpose.
    """
    config = agent_mod.build_agent_config()
    config["name"] = "kirocrew-team-lead"
    config["description"] = (
        "Owns a goal end to end and runs a team on it: registers the work, "
        "splits it into ledger items, does the small focused ones itself with "
        "the full default toolset, dispatches a session for every other one, "
        "patrols that fleet event-driven, and decides what its children cannot."
    )
    config["prompt"] = agent_mod._TEAM_LEAD_SYSTEM_PROMPT

    tools = [ref for ref in (config.get("tools") or []) if isinstance(ref, str)]
    for server in ("@kirocrew-dashboard", "@kirocrew-work"):
        if server not in tools:
            tools.append(server)
    config["tools"] = tools

    granted = [ref for ref in (config.get("allowedTools") or []) if isinstance(ref, str)]
    for tuple_ in _TEAM_LEAD_SHIPPED_GRANTS:
        granted.extend(ref for ref in tuple_ if ref not in granted)
    config["allowedTools"] = _narrow_whole_server_grants(granted)
    config["mcpServers"] = _team_lead_mcp_servers(config)

    # ONE ceiling pass, over the whole assembled list and after every append, which
    # is what keeps the ceiling authoritative over this installer rather than beside
    # it: ``allowedTools`` is the one path that never reaches the PreToolUse gate, so
    # a host governing a verb must get a prompt here instead of a bypass.
    auto_approve._apply_allowed_tools_ceiling(config, source="_install_team_lead_agent")
    # Derived from the FILTERED list rather than restated, so a ceiling that strips a
    # grant strips its KAS rule with it. The shared writer version-gates the field.
    auto_approve._write_derived_permissions(
        config, config["allowedTools"], _TEAM_LEAD_AGENT_FILENAME
    )

    agent_mod.kiro_agents_dir_path().mkdir(parents=True, exist_ok=True)
    path = agent_mod.kiro_agents_dir_path() / _TEAM_LEAD_AGENT_FILENAME

    # ATTRIBUTION FIRST, then grant-shape validation. The order is the invariant:
    # never write to this path when its existing content was not written by this
    # installer, whether or not that content parses as a usable spec.
    #
    # Reusing the conductor installers' hardened reader rather than a plain load,
    # because it keeps the failure CLASS and a read that failed TRANSIENTLY must
    # leave the file alone -- holding it costs one rebuild, and replacing it on a
    # bad read costs the file.
    #
    # What that reader cannot decide for this caller is the other class. It answers
    # ``replace=True`` for several different things, and one of them is a document
    # it PARSED as an object and then rejected on grant SHAPE: an ``allowedTools``
    # that is not a list. Treating that as "no spec here" would skip attribution
    # altogether, so a hand-authored agent with one typo in that field -- the most
    # ordinary way for it to be malformed -- would be overwritten whole, which is
    # precisely the harm the attribution exists to prevent. So every
    # ``replace=True`` goes through one more read whose only job is attribution,
    # and a read that fails TRANSIENTLY in that second step holds rather than
    # writes: a file that parsed a moment ago is somebody's, so one I/O error in
    # the gap must not become permission to replace it.
    reason: str | None
    try:
        existing = _existing_spec_for_attribution(path)
        # Inside the same guard as the spec read, because attribution has a SECOND
        # read that can fail transiently -- the lineage sidecar -- and both failures
        # mean the same thing: the check did not run, so this pass must not write.
        reason = _attribution_reason(existing)
    except conductor_agents._SpecUnusable as exc:
        agent_mod.logger.warning(
            "%s: the spec on disk could not be read (%s); left in place, so the "
            "agent is installed from the next rebuild rather than from this one",
            _TEAM_LEAD_AGENT_FILENAME,
            exc.cause,
        )
        return InstallOutcome.HELD
    if reason is not None:
        # ERROR, and the level is the point: this installer's caller swallows at debug,
        # so without this line the one event an operator needs -- "your own agent is
        # occupying this filename, and the shipped one is therefore absent" -- would be
        # invisible at any ordinary level. Declining is not silent and not destructive.
        agent_mod.logger.error(
            "Refusing to overwrite %s: %s, so it was not written by this installer. "
            "The shipped team-lead agent is NOT installed while that file is there; "
            "move or rename it to let the agent be installed.",
            path,
            reason,
        )
        return InstallOutcome.DECLINED

    agent_mod._atomic_json_write(path, config)
    agent_mod.logger.info("Installed team-lead agent config: %s", path)
    return InstallOutcome.WRITTEN
