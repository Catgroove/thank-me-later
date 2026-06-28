# thank-me-later (tml)

An extensible "ship it" CLI/TUI tool. After an agent finishes a unit of work, tml
conducts a code-defined pipeline that branches, runs quality checks, reviews, opens a PR,
waits on CI, and responds to PR comments. Built on the philosophy "everything is a
plugin" (inspired by pi) over an opinionated set of sane defaults. Shorthand
"tml" plays on "spend time now, thank me later."

## Language

**Pipeline**:
The ordered, code-defined sequence of steps that tml executes on a single invocation.
The default pipeline ships with sane defaults; users compose or patch their own.
_Avoid_: Workflow, flow, chain, script

**Step**:
One addressable unit of work in a Pipeline (e.g. create branch, review, quality check, open PR,
wait for CI, respond to comments). Defined in code, not config. Receives accumulated
context from preceding steps and returns a result plus an optional flow signal.
_Avoid_: Task, stage, job, action

**Run**:
A single end-to-end execution of a Pipeline. Runs are one-shot, idempotent, and
re-entrant: a Run can be quit and resumed, and side-effecting steps detect work the
Git provider already reflects and skip it. The Git provider is the source of truth for everything
that has left the local machine (PR, comments, CI status); the Run Journal
covers the local, pre-PR portion.
_Avoid_: Session, job, build

**Run Journal**:
The file-backed record of what this machine executed during a Run, written to a
per-machine state directory *outside the working tree*
(`~/.local/state/tml/<checkout-key>/`, keyed by the checkout's absolute path so two
clones of one repo never collide) - never committed, never littering the repo. It stores
run metadata (`run.json`), the isolated Run workspace (`workspace/`), completed Steps,
serialized Artifact values (`artifacts/`), RoundRecords (`rounds.jsonl`), and optional Events
(`events.jsonl`). This is the durable foundation resume uses to decide which local work can
be replayed or skipped safely. The Run Journal answers "what did this machine execute?" The
Git provider answers "what is true about the PR, comments, checks, and mergeability now?"
Requires Artifacts to be serializable.
_Avoid_: State file, cache, checkpoint db, session, source of truth for PR state

**Trigger**:
What initiates a Run. The one canonical, in-the-box Trigger is an explicit ship action —
`tml ship`, or a harness skill / slash-command a person or agent invokes when work is
done. Triggers are an extensible surface: git-push interception, an agent-stop hook, a
Git provider webhook, or a cron are all additional Triggers a Plugin or Adapter may register,
each funnelling into the same idempotent engine. tml ships none of the implicit Triggers
by default.
_Avoid_: Hook, entry point, event

**Re-entry**:
A fresh, short-lived Run that picks up asynchronous work after the initial ship —
typically responding to PR comments or reacting to CI completion. Fired by a poll, a
Git provider webhook, a harness hook, or by hand; each re-entry recomputes what remains from
the Git provider. A long-lived `--watch` is merely a loop of re-entries; a multi-PR daemon is
a non-goal.
_Avoid_: Resume, retrigger, wake

**Parked Run**:
A Run that ended without finishing - cancelled, failed, or interrupted - and so sits in the Run
Journal as resumable. A bare `tml` on the same branch surfaces the parked Run through the Startup
gate rather than silently starting over.
_Avoid_: Stopped run, saved run, draft

**Orphaned Run**:
A Run still marked `running` whose owning process is gone - a crash or hard kill skipped the
cancellation path, so it never reached a terminal status. Distinguished from a genuinely live Run by
its recorded `owner` (pid + host): a dead pid on this host, or staleness on another, marks it
orphaned and therefore resumable. See Liveness.
_Avoid_: Stale run, zombie, dead session

**Liveness**:
The classification of a `running` Run as `live` (its owner process is running on this host),
`orphaned` (the owner is gone), or `unknown` (it is on another host we cannot probe). The Run's
metadata is its lock: `begin` refuses to re-enter a Run whose owner is live, so two engines never
share one journal and workspace ([[0021-reruns-consult-run-history]]).
_Avoid_: Heartbeat, lease, lock file

**Viewer**:
A read-only presentation of a Run, reconstructed by folding its recorded Event stream through the
same `present` reducer the live renderers use ([[0011-presentation-is-a-pure-fold]]). It conducts
nothing - no engine, no Providers, no mutation. It replays a finished Run's outcome, or tails a live
one (see Attach).
_Avoid_: Replayer, log viewer, history renderer

**Attach**:
Following a still-running Run read-only from another terminal: the Viewer tails the Run's growing
Event stream until a terminal Event. Attach never takes ownership - the Run stays owned by its
original process - so quitting detaches rather than aborting. Distinct from Re-entry (a new Run) and
resume (reclaiming a parked Run).
_Avoid_: Reattach, takeover, join

**Startup gate**:
The choice a bare `tml` presents on an interactive TTY when an unfinished Run for the current branch
exists: resume it, attach to it, start fresh, or list all Runs - instead of unconditionally starting
fresh. A non-TTY/CI run, `--plain`, or an explicit `--fresh`/`--resume` skips the gate
([[0021-reruns-consult-run-history]]).
_Avoid_: Prompt, menu, wizard

**Run picker**:
The interactive list of a checkout's recent Runs (`tml runs`, alias `tml ls`), from which one can be
opened: a finished Run in the Viewer, an unfinished one resumed, a live one attached to. Piped, the
same command prints a plain table.
_Avoid_: Run browser, dashboard, history list

**Conductor**:
The principle that tml — not the agent — owns the control loop. tml decides what runs
next; steps may delegate work to an agent but do not seize control.

**Provider**:
A pluggable external capability a Step calls into, selected by name in `tml.json` from a
registry the binary ships (`"harness": "pi"`, `"gitProvider": "github"`); Plugins can register
more. The two
kinds — Harness (run an agent task) and Git provider (the external code-host; GitHub first) — are
*distinct, typed domain interfaces*, deliberately NOT collapsed into one generic interface
(that would forfeit the type safety behind [[0003-declared-artifacts]]). What they share
is not their domain shape but that each is a configured, typed domain interface. They
differ on the temporal axis: the Git provider *polls* — its eventually-consistent reads (CI
settling, a PR becoming mergeable) return a Pending driven by `until` — whereas the
Harness *streams* — `agent.run` pushes progress and resolves a result, never a Pending
([[0009-harness-streams-git-provider-polls]]). Git is *not* a Provider — there is only one git, so the
engine exposes it natively as `ctx.git` rather than as a configured, swappable interface
([[0007-git-is-native-not-a-provider]]).
_Avoid_: Backend, driver, adapter, integration

**Pending**:
The result type for an eventually-consistent, *pollable* Provider operation — CI settling,
a PR becoming mergeable. These are Git provider reads: external state with a cheap "is it there
yet?" check. The engine owns a single `until(pending, {every, timeout})` primitive that
polls any Pending to resolution, so the pollable / synchronous distinction lives in the
*result type*, not in a per-Provider poll loop. Synchronous operations just return a
Promise. A Harness agent task is *not* a Pending — it streams and resolves a result, not a
thing you poll ([[0009-harness-streams-git-provider-polls]]).
_Avoid_: Future, deferred, task, poller

**Harness**:
The Provider that runs an AI coding agent. tml calls `agent.run(task)`, which streams the
agent's activity via `onProgress` and resolves a `Promise` with the result — it does not
return a pollable Pending ([[0009-harness-streams-git-provider-polls]]). Each `run` executes one
isolated agent task and must not continue prior conversational state unless a future explicit
option requests continuation. The harness is Claude Code, opencode, codex, pi, etc.,
abstracted behind one interface. Each gets its own small package that shells out to that
tool's headless mode (pi: `pi --mode json --no-session`); ACP is a future *additional*
backend, not the boundary. A Step runs on the Harness's own default model unless it pins a raw,
harness-specific model (verified at startup when the Harness can list its models); the
default pipeline names no models, so it stays portable by referencing nothing. tml can
also be *hosted inside* a harness as a plugin. The Provider abstraction is the Harness;
`ctx.agent` is the in-Step handle to the agent it runs — the one sanctioned use of
"agent," naming the call-site object rather than the abstraction.
_Avoid_: Model, LLM, assistant, agent (when naming the abstraction — the interface is Harness)

**Git provider**:
The Provider for the external code host where PRs, reviews, and CI live. GitHub is the
first and only initial implementation.
_Avoid_: Remote, host, SCM provider, platform

**Artifact**:
A named, typed value produced by one Step and consumed by others through the Run's
shared context. Steps declare the artifacts they `produce` and `consume`; tml validates
that every consumed artifact has a producer *before* the Run starts, so a misassembled
Pipeline fails before any side effect. Steps reference artifacts by name, not by the
identity of the producing Step, which keeps plugins decoupled.
_Avoid_: Output, result, value, payload (when referring to this shared, declared data)

**Plugin**:
A TypeScript module that extends the Pipeline — contributing Steps, Providers, or UI
components. A Plugin is authored against an *injected* API (`export default (tml) => {…}`)
and **never imports `@tml/core`**; it is referenced by **local path** from `tml.json`
(`"plugins": ["./.tml/deep-review.ts"]`) and evaluated by the binary's embedded runtime, so
it needs nothing installed in the target repo, in any language. The blessed default pipeline
(`@tml/defaults`) is itself just a Plugin built on the same primitives — bundled into the
binary and loaded first, but not privileged by the core, only by convention. Contrast with
Adapter (host integration).
_Avoid_: Extension, addon, module

**Adapter**:
A per-host integration package that lets tml run inside a harness (Claude Code,
opencode, …). It registers a trigger (skill / slash command / hook), consumes tml's
event stream to render progress in whatever UI the host allows, and may supply a
Harness Provider that launches isolated agent tasks through the host without inheriting the
host conversation. Adapters are as rich as each host permits; the core engine is identical
regardless of adapter.
_Avoid_: Plugin (reserve for pipeline extensions), integration, binding

**Event stream**:
The structured sequence of events the headless core emits during a Run (`step:started`,
`artifact:written`, `agent:progress`, `ask:pending`, `run:finished`, `run:cancelled`, …).
Events are emitted *live* as they occur — including `agent:progress` mid-Step — not
batched at Step boundaries. `artifact:written` carries the artifact's string form (`rendered`)
when it has one, so a consumer can surface produced values, not just their names; the engine
relays it unjudged and leaves selection/formatting to the presentation. All presentation — the
standalone TUI, CLI logs, and host Adapters — is a consumer of this one stream; the engine
itself draws nothing.
_Avoid_: Logs, output, feed

**Agent progress**:
The normalized, harness-agnostic stream of what an agent is doing during an `agent.run` —
text deltas and tool activity — surfaced as `agent:progress` events. Every Harness reports
it the same way (`onProgress`), so the engine, not the harness, owns turning it into the
one Event stream. The presentation (e.g. live TUI rendering) is a stream consumer's job.
_Avoid_: Stream, output, deltas, transcript

**Abort**:
The external cancellation of an in-flight Run, delivered as an `AbortSignal` on `ctx.signal`
that Providers observe — the agent subprocess is killed, the `until` poll loop stops — and
ending the Run with a `run:cancelled` event. Distinct from the `cancel()` Flow signal: an
Abort is an *outside* interrupt (a person hits Ctrl-C), whereas `cancel()` is an
*in-pipeline* decision a Step returns. Same English word, two mechanisms.
_Avoid_: Cancel (reserve for the Flow signal), kill, interrupt, stop

**Ship branch**:
The feature branch tml ships the work on. If you're already on a feature branch that isn't spent,
that's the Ship branch. Otherwise (the default branch, a detached `HEAD`, or a spent branch) the
Branch mode produces one. The Pipeline commits and pushes from the isolated Run workspace created
from the source checkout snapshot. The PR opens with the Ship branch as its head and the repo's
default branch as its base.
_Avoid_: Feature branch (too generic), ship-<sha> (only the `auto` mode's name shape)

**Spent branch**:
A feature branch whose PR has already merged or closed — so it's the wrong place for new work
(you stayed on it instead of switching back to the default branch). The `branch` Step detects this
by asking the Git provider for the branch's PR state (a squash-merge never makes the feature commits
ancestors of the default branch, so git alone can't tell), then cuts a fresh Ship branch off the
freshly fetched default branch.
_Avoid_: Stale branch, dead branch, merged branch (only one of the spent states)

**Branch mode**:
How the `branch` Step gets a Ship branch when you aren't on a usable feature branch (ADR-0012):
`ai` (the default — the agent names it from the diff), `auto` (a deterministic `tml/ship-<sha>`),
or `require` (refuse; you must already be on one). Selectable per pipeline; the Step is swappable
for a custom policy.
_Avoid_: Branch strategy, naming scheme

**Commit group**:
A set of Steps whose combined changes land in one commit, so the Run leaves a clean history that
separates the author's change from tml's fixes (ADR-0013). Spelled `commitGroup(...steps)`, it is a
commit Step placed after the wrapped Steps; grouping is positional (a commit captures everything
since the previous one) and a group that changed nothing makes no commit.
_Avoid_: Squash, checkpoint (that is the resume journal), stage

**Flow signal**:
A value a Step *returns* to control the Pipeline: skip the Step, cancel the Run early,
retry the Step, or goto another Step. Distinct from Ask, which is an *awaited* escalation
effect, not a returned signal: flow signals redirect control, Ask requests a decision. The
`cancel()` signal is an *in-pipeline* early exit a Step chooses; it is not an Abort (an
external interrupt — see [[abort]]).
_Avoid_: Control code, directive, command, branch (the mechanism is goto)

**Ask**:
The escalation primitive a Step uses to request a human (or agent) decision. It resolves
against whatever channel the run context offers: an inline prompt in the TUI when a
human is watching; a Git provider comment that *suspends* the Run when headless. A reply —
from a person or an agent — becomes a Re-entry that resumes the Run at the suspended
Step. An unanswered Ask is simply a suspended Run, not a failure.
_Avoid_: Prompt, confirm, question

**Finding**:
A normalized outcome from review, quality checks, tests, or CI: severity, action, title,
detail, optional location, and a deterministic id. Findings are records, not provider-specific
messages. They are the shared language for deciding what can be auto-fixed, what needs a user,
and what is informational. A finding id is reliable for addressing findings within one round, but
not authoritative identity across rounds: verification agents may reword titles or line numbers for
the same underlying issue.
_Avoid_: Comment, check result, issue

**Round record**:
One completed pass by a Step over a set of Findings. A Round record names the Step, the Step-local
round index, why it ran (`initial`, `auto_fix`, `user_fix`, `verify`, `approval`), findings,
selected finding ids, optional user notes, fix summary, and commit SHA. Completed rounds are
appended to the out-of-tree journal so review, checks, and CI can be summarized from one record
shape.
_Avoid_: Pass log, report, transcript

**Max fix attempts**:
The `tml.json` knob (`maxFixAttempts`, default 3) bounding automatic repair loops in review,
checks, and CI. Each fix round spends one attempt; verification owns reconciliation and reports only
what remains or was newly introduced.
_Avoid_: Retry budget, stall guard, infinite-loop detector

**No progress**:
A round-loop stop reason used when a fix round produces no commit and the following verification
still reports findings. With a named Step it escalates through the approval gate; without one the
loop ends. It replaces cross-round finding-id equality as the signal that another automatic pass is
unlikely to help.
_Avoid_: Stalled, unchanged findings

**Review thread**:
A line-anchored (`path:line`), resolvable conversation on an already-open PR. Review threads are
post-PR provider facts, not part of the base local review/check pipeline and not part of the base
`PullRequest` model. The default review step emits Findings and Round records; it does not post its
own Findings as review threads. A later post-PR reconciliation step may introduce a `ReviewThread`
model and provider methods for reading, replying to, and resolving actual PR conversation.
_Avoid_: Finding (review output), PR body summary, top-level PR comment
