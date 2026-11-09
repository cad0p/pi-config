pr: cad0p/<repo>#<N>
round: 1
kind: impl
split-of: cad0p/<repo>#<N>
Threat model: <the parent PR note's threat-model value>

<!-- TEMPLATE NOTES: delete this block in the real brief.
Canonical split-brief template. Home: cad0p/pi-config agent/steering/templates/split-brief.md, next to the rule that points here (design-check-gate.ts roundCapReason; design-check-gate.test.ts pins that this file exists and that its header block passes the brief-header gate).
When: the moment the round cap refuses a brief, or a capped PR (round cap reached) needs ANY code change: a lens finding, a gate refusal, a live-leg defect, a design-check redesign. The only head move on a capped PR without a split is an absorb of main (absorb-of: exemption).
Never ask the owner first (owner 2026-11-09, verbatim: "The PR never comes to me unless there is a real need of the owner. I would rather you split it, which is the original intent, because clearly if there is more rounds, it needs to be smaller" and "you should just split the PR").
How: copy this file, fill every <...>, keep the five header lines above first, and write the result with the write tool to <state>/briefs/<N>-split.md (<state> = $PI_H4_STATE_DIR or ~/.local/state/h4-orchestration). Do not cp the unfilled template into briefs/: the brief-header gate refuses placeholders, by design. Then launch one split author (subagent) with the filled brief as its prompt.
Header: pr: and split-of: both name the PARENT (the pieces have no PR numbers yet); kind: impl is never round-capped; each piece's own later briefs carry pr: <piece PR>, round: 1, split-of: <parent> and restart at round 1 only when the piece's changed paths are a SUBSET of the parent's and its changed lines strictly FEWER (else it inherits the parent's round count). There is no one-split limit: a piece that reaches round 5 splits again.
Method: Goldmine open-source/guides/2026-11-08-cutting-a-round-5-split-by-finding-ownership.md. Rule: pc-host docs/verification.md 'Split at round 5'; ruling Goldmine personal/github/pc-host/decisions/2026-11-06-base-no-round-on-red-head-and-split-at-round-5.md. Worked briefs (H4 state dir, if present): briefs/193-split.md, briefs/417-split.md, briefs/197-split.md.
After the author reports, the orchestrator: files a piece-A issue if needed ('Part of #<issue>'), files PR A and PR B (gh, alone, body from the vault notes), closes the parent with a comment linking the pieces (superseded), launches each piece's r1 lens trio.
-->

# Split brief: <repo> #<N> (<title>; parent head <40-hex>, <files> files +<a>/-<d>) -> split into smaller PRs

Why: #<N> is past its review cap (<last round + verdict summary>) and <the finding / refusal / defect, with file:line and the evidence path>. <If a fix already exists: commit sha, branch, worktree, RED/GREEN, CI path, state file.> Owner rule: past the cap -> split, smaller pieces, fresh round 1 each.

You are the split author. Repo /home/pier/personal/github/<repo> (fetch first). <repo> main = <40-hex>. Parent worktrees are read-only to you; make NEW worktrees /data/tmp/wt/<N>a, /data/tmp/wt/<N>b. TMPDIR=/data/tmp/<N>split-tmp (SHORT). State /data/tmp/<N>-split-state.md.

The cut (orchestrator ruling; verify the premise first - if false, STOP and report):
- Piece A "<name>" = <paths>. Premise: A alone is coherent, passes the repo's CI suites, and <what it deploys / that it is inert>.
- Piece B "<name>" stacked on A (branch based at A's head) = <remaining paths> + the fix as its own signed commit.
- Cut by finding ownership: each blocking finding lives in exactly one piece, which carries its fix. If a blocking finding lives in the piece meant to be clean, the cut is wrong: STOP and report.
- The change set is merge-base..parent-head, not main..parent-head. Take files per path (git checkout <parent-head> -- <paths>), union-resolve where main moved the same files, and do not import the parent branch's merge artifacts.
- Both pieces together equal the parent head's tree plus exactly the fix diff: prove it hunk by hunk.
- Shrink check per piece: paths SUBSET of the parent's, changed lines strictly FEWER (git diff --shortstat; B against A's head). Record the numbers.
- Workflow paths (.github/workflows) in a piece: its merge needs 'tools/merge-pr.sh dispatch' - note which piece.
- Suites per piece after the LAST edit, on a committed tree: the repo's tools/ci.sh (--container where supported, under systemd-run --user --unit <N><a|b>-ci --collect; wait for any running gate or pc-ci container, never kill one); summary 'result: PASS' (+ 'run on: snapshot commit <head>' where printed). The fix's RED/GREEN on its piece.
- Push both branches.

Rules: Signed commits only (git commit -S -F <msgfile under /data/tmp>). Push branches plainly (never force). No GitHub writes (the orchestrator files issues/PRs and closes the parent). No host access, no converge, no live legs. Never /dev/shm, pkill -f, force-push, reset --hard, edits/checkouts under ~/.local/share/pc-merge/* or ~/.local/state/pc-merge/* (fetch only). Recursive rm only with absolute paths. Checkpoint the state file after each step (you may be cut at 30 min; a resume reads it).

Read first: pc-host docs/verification.md 'Split at round 5' (git -C /home/pier/personal/github/pc-host show origin/main:docs/verification.md | grep -n -i -A12 'split at round 5') and Goldmine open-source/guides/2026-11-08-cutting-a-round-5-split-by-finding-ownership.md. The split-shrink rule: a piece restarts at round 1 only when its changed paths are a SUBSET of the parent's and its changed lines strictly FEWER. Owner direction (2026-11-09), verbatim: "The PR never comes to me unless there is a real need of the owner. I would rather you split it, which is the original intent, because clearly if there is more rounds, it needs to be smaller" and "you should just split the PR".

Vault: 'git -C /home/pier/personal/github/Goldmine fetch -q origin' then ONE command 'git -C /home/pier/personal/github/Goldmine worktree add -b vault/<N>split /home/pier/personal/github/gm-<N>split origin/main'. Write: (1) a PR note per piece under the parent's repo prs/ (split-of: <parent>; piece A says 'Part of #<parent issue>', the LAST piece 'Closes #<parent issue>'; threat-model key as the parent note; maintainer_account_id: 14107574; reviewed history of the parent summarised with a link to the parent's note; the ledger it inherits (open blocking findings in its files, recurring-class decisions); the four decision fields at column 0 (workstream, owner direction (VERBATIM with date/source - use the quote above plus the parent's own owner direction), design (wikilink), departure); a live-proof line per piece stating what it deploys, or n/a with the reason); (2) update the parent's PR note: status 'superseded by the split (pieces A and B)'. Add and commit as SEPARATE commands; push HEAD:main (pull --rebase --gpg-sign if rejected); merge-base --is-ancestor check; LEAVE the worktree.

Report under 250 words: premise check, the cut (file lists), both heads, tree-equality proof, shrink numbers, CI summary paths per piece, fix RED/GREEN, what each piece deploys, Goldmine sha.
