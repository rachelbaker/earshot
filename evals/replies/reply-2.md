I can't find your test suite from here, so I can't give you specific recommendations yet.

The working directory is `/tmp/shape`. It contains only seven empty files (`reply-1.md` through `reply-7.md`) and no code, package manifest, or test config. I also can't search the parent `earshot` directory, because this session is limited to the `shape` folder.

Could you tell me where the test suite lives? Either point me to the repo, or start a session in it. It would also help to know the language and runner (Jest, Vitest, pytest, Go test, Playwright, etc.) and roughly how long the suite takes now.

In the meantime, these are the usual levers, roughly in order of payoff:

1. **Find the slow tests first.** Most runners can report per-test durations (`jest --verbose` with timing, `pytest --durations=20`, `go test -v` with timings, `vitest --reporter=verbose`). Often a handful of tests account for most of the time.
2. **Run tests in parallel.** Jest and Vitest parallelize by default across workers, pytest needs `pytest-xdist` (`-n auto`), and Go parallelizes packages by default with `t.Parallel()` inside tests.
3. **Remove shared setup cost.** Move expensive fixtures (database connections, browser launches, server boots) to suite or session scope instead of per-test. Reuse a database and reset it with transactions or truncation.
4. **Replace real I/O with fakes where it's safe.** Network calls, sleeps, and real timers are the usual culprits. Fake timers and mocked HTTP clients usually cut these down a lot.
5. **Run only affected tests locally.** Use changed-file selection (`jest --onlyChanged`, `vitest related`, `pytest --testmon`) and keep the full suite for CI.
6. **Cache in CI.** Cache dependencies and build outputs, and split the suite across CI shards.
7. **Split by speed.** Mark slow integration or end-to-end tests separately so the fast unit suite can run on every save.

Send me the repo path or the runner and I'll look at the config and slow tests and give you a specific plan.
