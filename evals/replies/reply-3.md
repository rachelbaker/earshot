Git commit hashes are content addresses. A commit's SHA is computed from its contents: the tree (snapshot of files), the parent commit hash(es), the author and committer names, emails, and timestamps, and the message. Change any of those and you get a different hash.

Rebase changes those inputs in two ways:

1. **The parent changes.** Rebasing replays each commit on a new base, so each replayed commit points to a new parent. Even if the diff is identical, the parent hash is different, so the commit hash is different.
2. **The committer info changes.** Replaying a commit records a new committer timestamp (and usually the current committer identity), which also changes the hash.

Because each commit names its parent, the change cascades. Rewriting one commit gives its child a new parent, which gives that child a new hash, and so on up to the branch tip. A rebase of a 10-commit branch produces 10 new commits.

The old commits aren't deleted. They stay in the object database until garbage collection, and the reflog records where the branch used to point (`ORIG_HEAD` holds the pre-rebase tip), so you can recover them with `git reflog` or `git reset`.

This is why rebasing is safe on local work but disruptive on shared branches. Anyone who has the old commits will see their history diverge from yours, so force-pushing a rebased branch forces collaborators to reconcile. Git only rewrites commits that actually move, though. If your branch is already based on the target, `git rebase` fast-forwards and keeps the original hashes.
