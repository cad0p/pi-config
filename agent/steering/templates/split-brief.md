pr: <owner>/<repo>#<N>
round: 1
kind: impl
split-of: <owner>/<repo>#<N>
Threat model: <the parent PR's threat-model section>

<!-- TEMPLATE NOTES: delete this block in the real brief.
Generic split-brief template, shipped next to the round-cap rule (design-check-gate.ts); design-check-gate.test.ts pins that it exists, that its header block is the fields the rule reads, and that it names no private path or project.
When: the round cap refuses a brief, or a PR at its cap needs ANY code change (a review finding, a gate refusal, a live-test defect, a design redesign). Split; do not put the PR to the owner. The only head move on a capped PR without a split is an absorb of the base branch (absorb-of: exemption).
How: copy this file, fill every <...>, keep the header lines above first, write the result with the write tool to <state>/briefs/<N>-split.md, then launch one split author with the filled brief as its prompt. Never copy the unfilled template into briefs/: the brief-header gate refuses placeholders, by design.
Local addendum: when the round-cap refusal names a local addendum file, apply it too (it carries the private specifics this public template leaves as placeholders: local paths, the never-list, the notes/vault steps, the owner's own wording).
Header: pr: and split-of: both name the PARENT (the pieces have no PR numbers yet); kind: impl is never round-capped. Each piece's later briefs carry pr: <piece PR>, round: 1, split-of: <parent>, and restart at round 1 only when the piece's changed paths are a SUBSET of the parent's and its changed lines strictly FEWER (else it inherits the parent's round count). There is no one-split limit: a piece that reaches round 5 splits again.
After the author reports, the orchestrator files the piece PRs (bodies from the author's notes), closes the parent as superseded with a comment linking the pieces, and launches each piece's round-1 review.
-->

# Split brief: <repo> #<N> (<title>; parent head <40-hex>, <files> files +<a>/-<d>) -> split into smaller PRs

Why: #<N> is past its review cap (<last round + verdict summary>) and <the finding / refusal / defect, with file:line and the evidence>. <If a fix already exists: commit, branch, RED/GREEN evidence.> Rule: past the cap -> split into smaller pieces, each restarting at round 1.

You are the split author. Repo <local clone> (fetch first). Base branch head = <40-hex>. Parent worktrees are read-only to you; make NEW worktrees <worktree root>/<N>a and <worktree root>/<N>b. Keep a state file at <state file> and update it after each step, so a resumed author can continue.

The cut (orchestrator ruling; verify the premise first - if false, STOP and report):
- Piece A "<name>" = <paths>. Premise: A alone is coherent, passes the repo's CI, and <what it deploys / that it is inert>.
- Piece B "<name>" stacked on A (branch based at A's head) = <remaining paths> + the fix as its own commit.
- Cut by finding ownership: each blocking finding lives in exactly one piece, which carries its fix. If a blocking finding lives in the piece meant to be clean, the cut is wrong: STOP and report. Non-blocking findings stay in the parent's follow-up issue.
- The change set is merge-base..parent-head, not base..parent-head. Take files per path from the parent head, union-resolve where the base branch moved the same files (record each resolution), and do not import the parent branch's merge artifacts (duplicated blocks, stale pins).
- Tree equality: both pieces together equal the parent head's tree plus exactly the fix diff; prove it hunk by hunk.
- Shrink check per piece: paths SUBSET of the parent's, changed lines strictly FEWER (git diff --shortstat; B against A's head). Record the numbers.
- Per-piece CI after the LAST edit, on a committed tree: <the repo's CI command>; record the summary path and result. The fix's RED/GREEN on the piece that carries it.
- Commit as the repo requires (signed if required). Push both branches plainly (never force). No PR/issue writes: the orchestrator files them.
- Notes: one note per piece (split-of: <parent>; the ledger it inherits: open blocking findings in its files and their round count; what it deploys, or n/a with the reason), and mark the parent's note superseded by the pieces.

Rules: <the local never-list and environment rules, from the local addendum>.

Report under 250 words: premise check, the cut (file lists), both heads, tree-equality proof, shrink numbers, CI summary per piece, fix RED/GREEN, what each piece deploys, notes commit.
