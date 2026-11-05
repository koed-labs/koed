# Benchmark Results

This page reports one comparison of an AI Client with and without Koed. The
comparison was assessed on 2026-10-27.

It measures repeated work. Koed had earlier successful sessions for every task,
and some of those sessions used reference help. The results do not show how Koed
performs on tasks it has not seen.

## Setup

- **Tasks:** 20 selected, CPU-only Terminal-Bench 4 tasks.
- **Runs:** 3 per task, per condition. That is 60 runs without Koed and 60 runs
  with Koed.
- **Model:** `gpt-6-luna`, with max effort requested. The provider did not
  separately confirm the effort it used.
- **With Koed:** the full pipeline, which is import, Projection, local embeddings,
  LCM summaries, MCP, and the Memory Answer helper. The helper ran on Luna at high
  effort, and LCM ran on Luna at medium effort.
- **Scoring:** the official Terminal-Bench verifiers. Task limits and native
  guidance did not change.

## Results

| Measure                     | Without Koed | With Koed   | Change     |
| --------------------------- | ------------ | ----------- | ---------- |
| Runs passed                 | 7 of 60      | 38 of 60    | 5.4x more  |
| Pass rate                   | 11.7%        | 63.3%       | +51.7 pts  |
| Coding time, total          | 1,173.4 min  | 564.1 min   | 51.9% less |
| Coding time, mean per run   | 19.6 min     | 9.4 min     | 51.9% less |
| Coding time, median per run | 8.44 min     | 6.69 min    | 20.7% less |
| Coding time, p95 per run    | 67.3 min     | 25.5 min    | 62.2% less |
| Prompt tokens, coding       | 441,466,964  | 138,059,170 | 68.7% less |
| Output tokens, coding       | 5,403,941    | 2,847,789   | 47.3% less |
| Estimated cost, known total | $8.09        | $4.66       | 42.4% less |
| Estimated cost per pass     | $1.16        | $0.12       | 89.4% less |

The median saving is much smaller than the total saving. Much of the time saved
comes from avoiding very long runs.

Coding time includes tools and waiting for the Memory Answer helper. Prompt tokens
include repeated context and cache reads. Cache reads were 97.6% of prompt tokens
without Koed and 95.4% with Koed.

The 95% Wilson ranges for pass rate are 5.8% to 22.2% without Koed and 50.7% to
74.4% with Koed. An exploratory resample of whole tasks gave a change of +31.7 to
+71.7 points. Runs and tasks depend on each other, so both are descriptive only.

## Cost

These figures are API-equivalent estimates from a frozen rate card. They are not
subscription charges or current prices.

| Item                       | Without Koed | With Koed |
| -------------------------- | ------------ | --------- |
| Coding                     | $8.09        | $3.38     |
| Memory Answer helper       | None         | $0.63     |
| LCM summary preparation    | None         | $0.65     |
| **Known total**            | **$8.09**    | **$4.66** |
| Coding only, cost per pass | $1.16        | $0.09     |

The all-in cost with Koed is unknown:

- Helper usage is missing for 3 of 60 runs, so the real helper cost is higher.
- Setup, retrieval infrastructure, and source generation are not included.
- LCM preparation came from 6 experimental rebuilds. Normal use does not reimport
  the full history for each question.

The same overhead also uses tokens. Helper usage adds 11,880,651 known prompt
tokens, and LCM preparation adds 6,543,452. With both, prompt tokens are 64.6%
lower instead of 68.7% lower.

## Per Task

Each cell shows passing runs out of 3.

| Task                        | Without Koed | With Koed |
| --------------------------- | ------------ | --------- |
| batched-eval-parity         | 0            | 0         |
| bun-sourcemap-leak          | 0            | 0         |
| cargo-flight-dispatch       | 0            | 3         |
| coq-block-bound             | 3            | 3         |
| embedding-drift-monitor     | 0            | 3         |
| fin-saccr-rwa               | 0            | 3         |
| foodstuff-beta-activity     | 0            | 2         |
| freecad-spring-clip         | 0            | 3         |
| glycan-ms2-elucidation      | 0            | 0         |
| interleaved-vigenere        | 0            | 3         |
| mp-checkpoint-consolidation | 1            | 3         |
| music-harmony               | 0            | 0         |
| mvcc-lsm-compaction         | 2            | 3         |
| ontology-kg-querying        | 0            | 0         |
| production-planning         | 0            | 0         |
| roy-polymorph-cn            | 0            | 3         |
| session-window-debug        | 1            | 3         |
| sound-change-cascade        | 0            | 3         |
| vllm-deepseek-streaming     | 0            | 3         |
| wal-recovery-ordering       | 0            | 0         |

12 tasks improved and none got worse. Of the 8 unchanged tasks, 7 failed in every
run and 1 passed in every run.

## Limits

- This is a full-pipeline comparison on selected tasks. It is not a full
  Terminal-Bench 4 run, a leaderboard entry, a first-attempt test, or a model
  ranking.
- The tasks ran as two groups of ten, at different times, with a shared corpus.
  This was not one randomized experiment.
- The whole-task resampling method was chosen after some results existed. The
  analysis was not preregistered.
- 2 runs without Koed ended with no verifier result. They use the official score
  of zero, as the protocol requires. No run with Koed needed this.
- No run was replaced or rerun to get a better result.
- The helper found an answer in 83 of its 104 retained calls and reported
  insufficient evidence in 17. A found answer does not prove that the answer was
  correct or that the task passed.
