# Coordination boundary

`office-hud/` is currently tracked by **two** repositories at once. This note
records exactly where each piece of work lives, so a later migration does not
guess and does not disturb anyone else's session.

## The two owners

| | repo | tracks | remote |
|---|---|---|---|
| A | `openalice-fleet` (superproject) | 91 files under `office-hud/` | `goodwearrinfo-aryan/openalice-fleet` (private) |
| B | `openalice-fleet/office-hud` (nested) | its own tree | `goodwearrinfo-aryan/office-hud` (public) |

Same working tree, two independent histories. Repo B is the **canonical** repo.
Repo A's copy of `office-hud/` is frozen and must not be modified until the
migration below is run deliberately.

## State as of 2026-10-03

**Canonical and safe — committed to repo B, pushed.**

- Everything under `electron/` — the native shell, its tests, packaging, and
  `LAUNCH-CHECKLIST.md`.
- `web/src/native.ts` — the preload bridge module. Note: committed in `8819a73`
  together with `electron/`. It is a standalone new file and does not overlap
  any other session's work.

**Uncommitted on purpose — entangled with another session.**

- `web/src/App.tsx` — my change is the `native` import plus one `useEffect`
  that routes shell menu commands into existing state. The rest of the file's
  diff (≈255 lines) belongs to another session.
- `web/src/index.css` — my change is the `html[data-native='1']` block at the
  end. The rest of the diff (≈2977 lines) belongs to another session.

**Another session's working state — not ours, do not touch.**

- 24 modified tracked files, 37 untracked files, 6 deletions in repo B.
- 19 entries in repo A's working tree.
- Repo A holds two stashes that are that session's backups:
  - `stash@{0}` pre-sync full worktree backup 2026-09-25
  - `stash@{1}` screener page / order-book depth / sound alerts

**Repo B only — recoverable, and a decision for their owner.**

Six components exist in repo B's history but not in repo A, and are currently
**deleted in the working tree** by the session that is refactoring:

- `web/src/components/Charts.tsx`
- `web/src/components/ExecutiveHQ.tsx`
- `web/src/components/ExportButton.tsx`
- `web/src/components/GlobalSearch.tsx`
- `web/src/components/GodConsole.tsx`
- `web/src/utils/export.ts`

All six are in repo B's `origin/main` at commit `a1c158c`, so nothing is lost.
The deletion is uncommitted and **must not be ratified by anyone else**.

## Prohibited until the migration is authorised

- `git rm --cached -r office-hud` in repo A.
- `git reset`, `git stash`, `git clean`, or any other index-changing operation
  against repo A's active tree or repo B's shared working tree.
- Committing `App.tsx` or `index.css`, which would sweep another session's
  in-flight work into an unrelated commit.
- Touching `:4747`. It is an SSH forward to the deployment host (pid 63082) and
  is how the HUD is reached today.

## When fleet untracking is authorised

Do it as a staged, reversible migration, not a single command:

1. Freeze repo B: no further commits while repo A still tracks the same paths.
2. Record a before-index diff of repo A's `office-hud/` paths.
3. Decide the six deleted components explicitly — restore them, or record the
   deletion as intentional with the commit that removes them.
4. Commit repo B's remaining uncommitted web work, so repo A's untracking
   cannot orphan it.
5. `git rm --cached -r office-hud` in repo A, then show the after-index diff.
6. Push repo B first. Repo A's removal is a pointer move and is recoverable
   from its own history.

## Remaining gate

The shell has never been launched — no display was available. `LAUNCH-CHECKLIST.md`
is the gate, and section C covers the WiFi-off path explicitly. The app is not
ready to ship until that checklist is performed on a machine with a display.