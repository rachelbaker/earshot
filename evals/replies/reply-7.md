Before you run it, check these:

- **Back up the current remote tip.** Note the SHA so you can restore it if needed:
  ```
  git fetch origin
  git rev-parse origin/main
  git branch backup/main-before-force origin/main
  ```
- **Confirm what you're about to overwrite.** Make sure nobody has pushed since your last fetch:
  ```
  git log --oneline HEAD..origin/main
  ```
  If that shows commits you don't recognize, they'll be lost by a plain force push.
- **Use `--force-with-lease` with the expected SHA.** It refuses the push if the remote has moved since you looked:
  ```
  git push --force-with-lease=main:<sha-from-above> origin main
  ```
  Plain `--force` can silently erase a teammate's push.
- **Check branch protection.** If main is protected, GitHub will reject the force push until you temporarily allow it or an admin does.
- **Tell collaborators.** Anyone who has pulled main will have diverged history and will need to reset or rebase. CI or deploys triggered by pushes to main will also run again on the rewritten commit.
- **Consider a revert instead.** If the mistake is a bad commit that's already shared, `git revert <bad-sha>` and push normally fixes it without rewriting history. Force-pushing is only worth it if the bad commit contains something that must not stay in history, like secrets or large files.

Recovery is possible if something goes wrong. Your local reflog and the backup branch keep the old commits, and `git reflog` on your machine shows the previous main position.

My working directory here isn't a git repository, so I couldn't inspect your branch or history. If you run the fetch and log commands above and paste the output, I can tell you whether the push is safe or what needs to change first.
