# Multi-file demonstration fixture

`before` deliberately fails all three tests. `after` passes the same tests.
Both package.json files and both check.test.cjs files are byte-identical.
The three implementation modules are the only intended edit targets.

Run from the repository root with Node 24:

```powershell
node --test examples/multi-file/before/check.test.cjs
node --test examples/multi-file/after/check.test.cjs
```

These are hand-authored reproducible examples, not saved model output.
Copy `before` to an isolated workspace before asking an agent to solve it.
Do not modify the preserved before/after directories during a comparison.
No credential, dependency download or provider request is required to run them.
