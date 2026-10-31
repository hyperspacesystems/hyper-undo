
## Tests that wait on the idle timer (2026-10-31)

- **Trigger:** `test-node/{scope,commands,extension-noise,codex-review-regressions,platform-namespace}.test.js` use `idleWindowMs: 20` and assert after `await tick(40)`, so a loaded machine can fire the timer late (empty history) or split one gesture across two windows.
- **Effect:** a release-loop run reports hyper-undo as unstable. `ignore-node.test.js` flaked this way on 2026-10-31 under `hypersave --test` and was fixed by a 60 s idle window plus `scope.flush()` before each assertion.
- **Revisit:** apply the same change to any of these files the first time it is reported unstable.
