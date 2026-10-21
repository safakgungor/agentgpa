# Grading

How AgentGPA turns the sessions on your machine into a report card. All of it lives in `@agentgpa/core`. The CLI uses it to measure your sessions and build the payload, and prints no grades; the AgentGPA server grades you with this same code, recomputing every number from the text-free event skeleton, and trusts no number a client sends. The numbers are data in `packages/core/src/grading/config.ts`, `thresholds.ts`, `archetypes.ts` and `traits.ts`; this page explains them. Grading version: `v0` (the anchors are calibrated with beta data, and any change bumps the version).

## The period and observed days

The period is the last 90 days by default (`--since 7d`, `14d` or `30d` for shorter reports), counted back from the moment of the scan.

Every tool counts the whole period. Claude Code deletes a transcript once it has gone unchanged for its `cleanupPeriodDays` setting (30 days unless you changed it), but a session file it keeps, for example one you came back to, still holds its older events, and those count like any other. Codex and Cursor keep everything. A tool's **observed days** are the days of the period it is counted over: the whole period for every tool. (Until 0.1.0, Claude Code's were `min(period, cleanupPeriodDays)`.)

- Events older than the period are left out of every metric.
- Attendance compares active days with observed days for each tool, so days whose sessions Claude Code already deleted count as days without work.
- Counts that grades, archetypes and activities compare with a threshold (secrets, cost, marathons, caps crises, commits) are scaled to **30 observed days** for each tool and then summed: `count x 30 / observedDays`.

So the same habits earn the same grades whichever window recorded them. A test checks the scaling: thirty days of a habit observed over 30 days and ninety days of it observed over 90 give the same grades.

## Courses

| Course | Input `x` | F anchor (scores 55) | A anchor (scores 95) |
| --- | --- | --- | --- |
| Attendance | active days / observed days, per tool, then the mean weighted by prompts | 0.10 | 0.60 |
| Prompt Craft | share of prompts with 8 or more words or a code reference | 0.20 | 0.70 |
| Focus | (corrections + 0.5 x interrupts) per 100 prompts | 40 | 5 |
| Manners | thanks per 100 prompts | 0 | 6 |
| Planning | share of sessions with 3 or more prompts that planned first | 0 | 0.40 |
| Security Hygiene | (pasted secrets + 0.5 x exposed secrets) per 30 observed days | 6 | 0 |
| Composure | (caps crises + swears + rage repeats) per 100 prompts | 8 | 0.5 |

What the inputs count:

- **Active day**: a local date with at least one prompt. Attendance caps each tool at 1.
- **Code reference**: backticks, a path or a file name with an extension, a stack trace line, `Error:` or a line number.
- **Correction**: a prompt that opens with a negation ("no", "nope", "wrong", "that's not", "undo", "revert", "hayır", "yanlış" and more).
- **Interrupt**: you stopped the agent mid-reply. It weighs half a correction.
- **Thanks, swears, corrections and plan requests** come from multilingual word lists in `lexicons.ts` (English, Turkish, Spanish, Portuguese, German, French and more), matched on word boundaries after folding case. Folding treats `I`, `ı`, `İ` and `i` as one letter, so Turkish works in every locale.
- **Planned session**: plan mode was on (Claude Code, Codex, Cursor), one of its first two prompts asks for a plan, or it names a plan file (a `.md` file called PLAN, SPEC, TODO, CLAUDE or AGENTS, in any case). Planning is graded per tool against that tool's own anchors (v0 starts every tool at 0 and 0.40), and several tools get the mean of their scores weighted by sessions.
- **Caps crisis**: a prompt with at least 3 words and 10 cased letters, 70% or more of them upper case. Scripts without case never count.
- **Rage repeat**: the same prompt again in the same session within 10 minutes. Every extra repeat counts.
- **Secrets**: see below.

## Score, letter and GPA

```
score = clamp(55 + 40 x (x - F) / (A - F), 0, 100)
```

The formula runs both ways: for courses where lower is better, F is above A. The score is rounded to one decimal, and a score exactly on a cut gets the higher letter.

| Letter | Lowest score | Points |
| --- | --- | --- |
| A | 93 | 4.0 |
| A- | 90 | 3.7 |
| B+ | 87 | 3.3 |
| B | 83 | 3.0 |
| B- | 80 | 2.7 |
| C+ | 77 | 2.3 |
| C | 73 | 2.0 |
| C- | 70 | 1.7 |
| D | 60 | 1.0 |
| F | 0 | 0.0 |

GPA is the mean of the seven grade points, rounded to two decimals.

### Worked examples

These are also tests (`packages/core/test/grading.test.ts`).

- Attendance `x = 0.35`: 55 + 40 x 0.25 / 0.50 = 75, a C (2.0).
- Composure `x = 2`: 55 + 40 x (2 - 8) / (0.5 - 8) = 87, a B+ (3.3).
- Focus `x = 60`: 55 + 40 x (60 - 40) / (5 - 40) = 32.1, an F.
- Focus with 188 corrections and 136 interrupts in 1,284 prompts: `x` = (188 + 0.5 x 136) / 1,284 x 100 = 19.94, which scores 77.9, a C+ (2.3).
- Manners with 64 thanks in 1,284 prompts: `x` = 4.98, which scores 88.2, a B+ (3.3).
- Security Hygiene with one pasted secret in 30 observed days: 55 + 40 x (1 - 6) / (0 - 6) = 88.3, a B+ (3.3).
- Security Hygiene with one pasted secret over 90 observed days: `x` = 30 / 90 = 0.33, which scores 92.8, an A- (3.7).
- Security Hygiene with no secrets: 95, an A (4.0).

## Incomplete

Fewer than 20 prompts or fewer than 3 active days: no GPA. The card still shows the courses and says "Incomplete: come back after more classes."

## Honors and Detention

- **Dean's List**: GPA 3.7 or higher. **Academic Probation**: GPA under 2.0.
- **Detention**: a secret was pasted into a prompt or read by your agent. The card shows only the count. `agentgpa --details` shows the types and how to keep secrets out of your agent's reach, on your machine only.

## Secret detection

- Provider patterns only, no generic entropy rule: AWS keys, GitHub tokens, OpenAI and Anthropic keys, live Stripe keys, Google Cloud keys, Slack tokens, private key blocks, JSON web tokens, database URLs with a password, and other providers such as npm and Hugging Face.
- A keyword check decides whether a text needs scanning, then one combined pattern runs.
- Not counted: placeholders and documentation examples, Stripe test keys, database URLs on your own machine and template credentials, Supabase's local demo keys and public anon keys (JSON web tokens whose issuer is `supabase-demo` or whose role is `anon`), and GitHub tokens whose checksum fails, since GitHub issues every token with one.
- **Pasted** secrets are in your prompts. **Exposed** secrets are in tool output that entered the agent's context (the first 64 KB of each output), and were not pasted too. Web pages and MCP results are skipped: their example keys are not yours.
- Each distinct secret counts once, for the tool that saw it first.
- Only counts by type leave the scan. Values stay in memory, and the in-memory hashes used to count each secret once are dropped when the scan ends.

## Archetypes

The first rule that matches wins.

1. **The Conductor**: 4 or more sessions at once.
2. **Caps Lock Captain**: Composure D or F.
3. **Night Architect**: 35% or more of prompts between midnight and 5 AM, and 15 or more words per prompt on average.
4. **The Micromanager**: Focus C- or lower.
5. **The Diplomat**: Manners A- or A.
6. **Speedrunner**: a median activity block of 15 minutes or less, and 20 or more prompts per active hour.
7. **Vibe Coder**: 60% or more of prompts under 10 words, and under 10% of sessions planned.
8. **Token Baron**: an estimated $2,000 or more per 30 observed days, at list API prices.
9. **Valedictorian** with a GPA of 3.5 or more; otherwise **The All-Rounder**.

## Activities

A report earns up to three, strongest evidence first. Evidence is the measure divided by its threshold, so 1 is just earned and 2 is twice the bar; ties keep the order below.

| Activity | Earned with |
| --- | --- |
| Night Shift Society | 35% or more of prompts between midnight and 5 AM |
| Early Bird Club | 20% or more of prompts between 5 and 9 AM |
| Marathon Club | 3 or more marathons per 30 observed days |
| Streak Team | 7 or more days in a row |
| Weekend Warriors | 30% or more of prompts on weekends |
| Context Club | 70% or more of prompts with context (8 or more words or a code reference) |
| Planning Committee | 40% or more of sessions planned |
| Debate Team | 30 or more corrections per 100 prompts |
| Orchestra | 3 or more sessions at once |
| Two-Tool Athlete | a second tool with 20% or more of the sessions |
| Polite Society | 6 or more thanks per 100 prompts |
| Drama Club | 20 or more caps crises per 30 observed days |
| Clean Desk Club | no secret pasted or exposed |
| Shipping Crew | 50 or more commits by the agent per 30 observed days |

## Measures behind them

- **Activity block**: the events of one session with gaps of 10 minutes or less. Its length runs from the first event to the last, plus a minute. Session start and end are never used, since sessions can sit open for days.
- **Marathon**: an activity block of 6 hours or more. **Sessions at once**: the most activity blocks open at the same minute, across sessions and tools.
- **Local time**: hours, dates and weekdays use your machine's time zone. Night is 00:00 to 04:59, early is 05:00 to 08:59, weekends are Saturday and Sunday. Some Cursor chats only record an approximate time; those prompts count everywhere except in time-of-day measures.
- **Short prompt**: under 10 words. **Abandoned session**: 1 or 2 prompts and under 3 minutes of activity.
- **Commits and pull requests by the agent**: shell commands the agent ran that call `git commit` or `gh pr create`. Counts only.
- **Estimated cost**: token counts times the list prices in `pricing.ts`, which records the date it was checked. Models without a list price are left out and counted, so the estimate never invents a price.
- **Per-day series**: one entry per local date the period touches, from the first to the last (both partial days), so they always add up to the totals.

The CLI also computes signals for the personal part of the report (rhythm, sessions, tone, collaboration, craft, shipping, models and cost). They never change a grade, an archetype or an activity.
