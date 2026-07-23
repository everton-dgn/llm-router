# Quality benchmark

Runs: V1 on July 20, 2026; V2 and the effort comparison on July 21, 2026.

This document describes only the offline benchmark. `quality_eval.py` reads
`benchmark_config.json` and uses `BenchmarkExecutor` to execute single-shot
calls. The external commands and provider environments in that configuration
reproduce the measurements and never participate in OpenCode routing. The
production runtime uses direct handoff to native providers and the local
adapter for the official Claude CLI.

## V1: initial pilot

This first benchmark compares the four executors configured in `llm-router`.
It does not isolate the base models or measure generalization. The matrix
contains six synthetic cases, four routes, and three repetitions per pair, for
a total of 72 single-shot calls in reproducible random order with seed 42.

## Methodology

- Each call uses a new temporary workspace.
- The executor calls `BenchmarkExecutor.execute_model` directly, without
  retries, escalation, `stage_prepare`, `stage_verify`, or an OpenCode reviewer.
- The rubrics are deterministic, and critical failures score the run as zero.
- Each route received 18 calls; each case received 12.
- All 72 calls finished with exit code zero, without a timeout or process error.
- The fixtures were sent to `trash` after the audit.

Command used:

```bash
uv run --no-project --no-python-downloads python quality_eval.py \
  --config benchmark_config.json \
  --cases tests/quality-cases.json \
  --routes minimax,glm,claude,codex \
  --repetitions 3 \
  --parallel 1 \
  --max-calls 72 \
  --seed 42 \
  --output /tmp/llm-router-quality-20260720-run2.json
```

## Rubric correction

The original report marked 31 failures. Inspection of the outputs found two
measurement errors:

1. The planning case accepted only one representation of `0.5%`, although the
   prompt did not specify a JSON unit or type. Equivalent responses used
   `0.005`, `"0.5%"`, or `0.5`.
2. The summary case required internal JSON types that the prompt did not
   define. The sentences preserved all facts and uncertainty, but values such
   as `"120 users"` failed because they were not the number `120`.

The audited report reapplied only output assertions. The 24 runs that depended
on the workspace kept their original evaluation, including scope violations.
No additional call was made.

| Artifact | SHA-256 |
| --- | --- |
| Original report | `1aeac33135248d7ede5867ff1bfc491139777a607a4b89cc58e9458f33603eb6` |
| Audited report | `93f7df8cf3466fb38011dde5684369d54f039ccf9ef8bc45d3fd67cc40bf1afc` |

## Local results

| Route | Original score | Audited score | Audited passes |
| --- | ---: | ---: | ---: |
| MiniMax M3 | 38.89% | 77.78% | 14/18 |
| GLM 5.2 | 61.11% | 94.44% | 17/18 |
| Claude Opus 4.8 `xhigh` | 61.11% | 94.44% | 17/18 |
| GPT-5.6 Sol `xhigh` | 66.67% | 100% | 18/18 |

| Category | Audited passes |
| --- | ---: |
| Lossless extraction and formatting | 12/12 |
| Faithful summary | 12/12 |
| Constrained planning | 12/12 |
| Faithful translation | 10/12 |
| Contained implementation | 10/12 |
| Code review | 10/12 |

The six audited failures were:

- MiniMax created `.serena/` in two implementations and two reviews, despite
  the allowlist and the prohibition against new files.
- GLM produced the malformed Portuguese word `répapas` in one translation.
- Claude wrote the Portuguese word `replicas` without the required accent in
  one translation.

In the single translation case, Codex passed 3/3, MiniMax passed semantically
3/3, GLM passed 2/3, and Claude passed 2/3. One synthetic sample does not
support a general conclusion about translation. The GLM floor remains a
conservative policy decision, not a claim that this pilot proved MiniMax
inferior in that area.

## Public metrics

The sources use different effort settings, scaffolds, and dates. The numbers
provide a directional signal and cannot be combined directly with the local
score.

- In [Artificial Analysis GDPval-AA v2](https://artificialanalysis.ai/evaluations/gdpval-aa),
  Claude Opus 4.8 appears with Elo 1600, GLM 5.2 with 1514, and MiniMax M3 with
  1396.
- The [official GLM 5.2 publication](https://z.ai/blog/glm-5.2) reports a
  Terminal-Bench 2.1 score of 81.0 for GLM, 65.0 for MiniMax, and 85.0 for Opus
  4.8; the published SWE-bench Pro values are 62.1, 59.0, and 69.2.
- The [official GPT-5.6 publication](https://openai.com/index/gpt-5-6/) reports
  a Coding Agent Index score of 80 and a Terminal-Bench 2.1 score of 88.8% for
  Sol, as well as 64.6% on SWE-bench Pro.
- The [official MiniMax M3 page](https://www.minimax.io/models/text/m3)
  emphasizes coding, tool use, and agentic tasks. It does not publish a
  translation-specific metric comparable to the other three executors.
- The [official Claude Opus 4.8 page](https://www.anthropic.com/news/claude-opus-4-8)
  presents gains in coding, judgment, and agentic tasks, but it also does not
  provide a comparable quantitative translation benchmark for this matrix.

## Historical policy after V1

- MiniMax: trivial non-mutating tasks such as counting, listing, searching,
  formatting, and short answers. In the configuration used for that run, the
  worker was limited to `Read,Glob,Grep` with no external MCP.
- GLM: the floor for translation and the default route for contained
  implementation.
- Claude: complex planning whose final deliverable is a plan, architecture, or
  ADR.
- Codex: difficult implementation, deep debugging, audits, and code review.

MiniMax read-only containment was applied after this run in response to the
four `.serena/` creations. At that point, it had passed only preflight and
local tests. V2 below executed 36 real slots with a profile limited to
`Read,Glob,Grep`.

The current profile system replaced that policy. The distributed bundle uses
`native` for all models. The user may select `restricted` to apply permissions
and limits or `full` to declare full access. Routing selects the worker, while
the execution profile controls tools separately. See
[Execution policies](docs/execution-policies.md).

The planning case saturated at 12/12 after the semantic correction and did not
distinguish the models. A future version needs several open-ended plans with
trade-off and risk evaluation before recalibrating the GLM versus Claude
boundary.

## V2: categories and difficulty

V2 covers 36 cases in 12 categories, at simple, intermediate, and difficult
levels. Thirty authorial or judgment-based cases received a blind review. The
remaining six cases use behavioral tests or deterministic criteria for bugs,
refactoring, and test writing.

The rubrics follow three public references:

- [WritingBench](https://arxiv.org/abs/2503.05244) separates six domains and
  100 subdomains and generates query-specific criteria.
- [LiveIdeaBench](https://arxiv.org/abs/2412.17596) measures originality,
  feasibility, fluency, flexibility, and clarity in ideation.
- The [Creativity Benchmark](https://arxiv.org/abs/2509.09702) collected
  11,012 anonymous comparisons from 678 creative professionals. The study found
  weak correlation and specific biases in LLM judges, so this project's
  automated blind evaluation is supplemental and is not labeled a human
  evaluation.

For code review, [SWE-PRBench](https://arxiv.org/abs/2603.26130) shows that
eight frontier models detected only 15% to 31% of the problems identified by
humans in 350 pull requests. It also found degradation from excessive context.
The local cases keep diffs short and findings verifiable, but they do not
demonstrate parity with human review.

### Runs and accounting

| Run | Slots | Recorded calls | Upper bound | Goal |
| --- | ---: | ---: | ---: | --- |
| Screening | 144 | 156 | 168 | One output per route and case |
| Rescore | 144 reused | 0 new | 0 | Correct only the assertions |
| Extra | 12 | 12 | 12 | Repeat transient failures and behavioral cases |
| Adaptive | 120 | 132 | 132 | Two new outputs for the two finalists in 30 cases |
| Unique total | 276 | 300 | 312 | Screening, extra, and adaptive |

Screening was interrupted while concurrency was being increased. Eleven slots
became ambiguous and reserved up to 12 additional calls. The artifact proves
300 recorded calls; 312 is only the upper bound. The rescore called no model.

The adaptive run used `--parallel 30` on a 10-core machine. It accumulated
11,570.66 seconds of slot duration and finished in 549.21 seconds of wall time,
an effective 21.07-fold speedup. The one-minute load average peaked at 71.50
during client creation, fell to 23.31 during execution, and returned to 3.03
afterward. In the intermediate sample, the CPU was 76.62% idle and memory
showed no new swap. The peak reflected processes waiting on the network and
models; there was no sustained CPU saturation.

Load average, CPU, and swap were observed live with `uptime`, `top`, and
`memory_pressure`; those samples are not part of the preserved JSON reports.
Counts, durations, and `--parallel 30` are present in the reports and
checkpoints.

The engine fingerprint aggregates `quality_eval.py` and all Python files under
`qeval/` in deterministic order. As expected, resuming checkpoints created
before modularization may be rejected because their fingerprints differ.

### Process reliability

Aggregate from the three runs that made calls, excluding the rescore:

| Route | Completed slots | Completed physical turns | Failures |
| --- | ---: | ---: | --- |
| Claude | 90/90, 100% | 99/99, 100% | 0 |
| Codex | 88/89, 98.88% | 97/98, 98.98% | 1 timeout |
| GLM | 54/61, 88.52% | 57/64, 89.06% | 5 timeouts and 2 errors |
| MiniMax | 36/36, 100% | 39/39, 100% | 0 |

GLM was the slowest executor and repeated a completion rate near 89% in both
screening and the adaptive run. The policy keeps one retry on the same route
and a fallback for tasks that start there.

### Deterministic compliance

| Artifact | Overall | Codex | Claude | GLM | MiniMax |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw screening | 44/144, 30.56% | 30.56% | 50.00% | 27.78% | 13.89% |
| Rescored screening | 43/144, 29.86% | 52.78% | 33.33% | 27.78% | 5.56% |
| Selected extra | 8/12, 66.67% | 100% | 100% | 42.86% | no sample |
| Selected adaptive | 45/120, 37.50% | 46.00% | 25.00% | 50.00% | no sample |

These percentages measure assertions such as strict JSON, required fields,
allowlists, canaries, and fixture behavior. The routes received different sets
in the selected runs, so their averages do not form a general ranking. Several
semantically strong responses scored zero after adding text outside the
requested JSON. That result is a real compliance failure, separate from
authorial quality.

### Supplemental blind quality

During screening, an LLM judge received 120 anonymized candidates and had no
access to the mapping, configuration, or reports:

| Route | n | Mean out of 7 | Median | Worst |
| --- | ---: | ---: | ---: | ---: |
| Codex | 30 | 6.682 | 6.835 | 4.55 |
| Claude | 30 | 6.609 | 6.635 | 5.98 |
| MiniMax | 30 | 5.668 | 5.885 | 1.63 |
| GLM | 30 | 5.656 | 6.315 | 1.00 |

Codex and Claude had a mean difference of 0.073. In the direct comparison,
Codex had 8 material wins, Claude had 3, and there were 19 ties at a threshold
of 0.3. MiniMax did not place in the top two in any of the 30 cases. This result
supported the historical preference for low-risk literal tasks, but it imposes
no tool restrictions in the current runtime.

The adaptive run added two responses for the two finalists in each case. This
produced 60 route-case pairs with three samples each. The same judge evaluated
all 120 candidates without identities. The aggregates below are selected and
must not be compared as a general ranking:

| Route | Selected pairs | Samples | Mean out of 7 | Worst |
| --- | ---: | ---: | ---: | ---: |
| Claude | 26 | 78 | 6.729 | 5.98 |
| Codex | 25 | 75 | 6.708 | 1.00 |
| GLM | 9 | 27 | 6.380 | 1.00 |

Scores of 1.00 correspond to empty outputs caused by timeouts and preserve the
reliability cost in perceived quality. Stable signals by category:

- Claude led product ideas at all three levels, with a mean of 6.779 versus
  Codex at 6.528.
- Codex led technical writing at all three levels, with a mean of 6.912 versus
  Claude at 6.562.
- GLM led simple and intermediate documentation. Codex remained the route for
  difficult documentation.
- Pull request review was nearly tied, at 6.964 for Codex and 6.922 for Claude.
  The route remains Codex because of specialization and policy.
- Brainstorming and open discussion were also close. The policy uses GLM for
  simple cases and Claude at higher levels to control cost and preserve the
  creative reasoning role.
- For social and sales copy, GLM produced good responses when it completed, but
  timeouts reduced its worst scores to 1.00. It remains on simple cases with a
  retry; Claude receives difficult cases; Codex receives technically precise
  intermediate social content.
- Intermediate and difficult tests were tied between GLM and Claude. The policy
  uses GLM through the intermediate level and Codex for the difficult level,
  following the user-defined difficult-engineering rule.

### Production matrix

| Category | Simple | Intermediate | Difficult |
| --- | --- | --- | --- |
| Open discussion | GLM | Claude | Claude |
| Brainstorming | GLM | Claude | Claude |
| Product ideas | Claude | Claude | Claude |
| Architecture | Claude | Claude | Claude |
| Pull request review | Codex | Codex | Codex |
| Technical writing | Codex | Codex | Codex |
| Documentation | GLM | GLM | Codex |
| Social content | GLM | Technical: Codex; general: GLM | Claude |
| Bug resolution | GLM | GLM | Codex |
| Refactoring | GLM | GLM | Codex |
| Test writing | GLM | GLM | Codex |
| Sales copy | GLM | Claude | Claude |

Translation continues to have a GLM floor. Architecture or complex planning
promotes to Claude. Review, audits, security, precise technical writing, and
difficult implementation promote to Codex. The matrix recommends MiniMax for
counting, listing, searching, literal extraction, mechanical formatting, and
direct facts. This recommendation affects automatic selection and does not
reduce the model's tools. Only an execution profile selected by the user can do
that.

### V2 artifacts

| Artifact | SHA-256 |
| --- | --- |
| Corrected dataset | `43934b32fd758f398e0a7a2d5318b41fee32936edd27628afb3a88d7469f184e` |
| Original screening | `7f85eb8e66d80d3cb8801769df4f68fad160b1636936e5386cf6e9e5c820fe3b` |
| Rescored screening | `b8d66845c98b896c6755f523fb869ed54b90950b44c12911d162d0877a74e9da` |
| Selected extra | `cef1772e5b628e48f096ceb095e11b1ccd2361f3801193a659e8dbf8af28682c` |
| Adaptive | `e71794680f6f78029616df0cdee9b79b9606a1afb477acb481897c08a6f82457` |
| Blind adaptive package | `e6721558838fbda044e0df6e9e3244a9b9a3b419785ad33b487dd3762ea8a2ff` |
| Private adaptive mapping | `dea1054b07573634c23c44b6c01aaa1a5ca4a3a8047b14781c484297c6138fbd` |
| Blind adaptive audit | `bf3f9bd34d886e0c491fed85568b482a98ccf7a6b80b9105658750fcae090afd` |

The hashes preserve the identity of the artifacts used in the audit. Raw
reports, blind packages, and the private mapping are not part of this
repository because they may contain provider outputs and execution metadata.
The results published here can therefore be audited through their methodology
and hashes, but they cannot be reproduced in full from the public checkout
alone.

A product decision may use the clear differences above. Creative cases with a
margin below 0.3 remain classified as ties pending human review.

## Reasoning effort comparison

A supplemental run compared `xhigh` and `max` where effort changes cost,
latency, or quality. This run has a small sample and serves to configure the
local router. It does not support a general ranking of models or effort
settings.

### GPT-5.6 Sol executor in the historical architecture

In the architecture used for that experiment, the same complete flow ran with
GPT-5.6 Sol at `xhigh` and `max`:

| Effort | Wall time | Findings in first review | Findings in final review |
| --- | ---: | ---: | ---: |
| `xhigh` | about 13 min | 10 | 6 |
| `max` | about 21 min | 11 | 12 |

`xhigh` finished about eight minutes earlier and left half as many findings in
the final review. That conclusion informed the historical configuration of
that flow. The current runtime does not keep a coordinator after handoff. The
findings measure the result of these two experiments without proving a stable
defect rate.

### Claude Opus 4.8

Four tasks received responses at `xhigh` and `max`, evaluated blindly:

| Task | Winner |
| --- | --- |
| Architecture | `max` |
| Product ideation | `max` |
| Copy | `max` |
| Open technical discussion | `xhigh` |

Across this run, `max` scored 8.05 versus 7.30 for `xhigh`. The defect count was
17 for `max` and 23 for `xhigh`. The resulting policy uses `max` for planning,
architecture, product, ideation, copy, and creative work. Open discussion,
debate, trade-offs, policy, and falsification use `xhigh`.

Claude's fallback is `max`. New categories require a comparison before
receiving an exception, and a future run should repeat all four pairs to measure
variance across executions.
