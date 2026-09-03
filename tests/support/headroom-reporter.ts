import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'

/**
 * How close each test runs to its own timeout.
 *
 * # Why this exists
 *
 * The 61MP export test ran for 34 seconds locally, exceeded a 600 second timeout
 * on CI, and **failed on two consecutive pushes before anyone noticed** — because
 * the local suite was green and nobody was looking at how long anything took.
 *
 * That is the second check in this repository's history to pass by not running.
 * The first was `tsc --noEmit`, recorded at Stage 2. Both had the same shape: the
 * signal that something was wrong was available and nothing was reading it.
 *
 * A test near its timeout is not a failure today and is a failure eventually,
 * because suites grow and runners vary. This makes the approach visible while it
 * is still approach.
 *
 * # The thresholds, and why these numbers
 *
 * Measured rather than guessed. The same CI job on this repository has taken
 * between 6m13s and 19m50s for equivalent content — a **factor of three** in
 * runner speed alone, before any change to the suite. A test comfortable at 30%
 * of its timeout on a fast runner is at 90% on a slow one, which is exactly the
 * failure this is meant to prevent.
 *
 * So: **fail above half**, which leaves a 2x margin and is already thinner than
 * the observed variance, and **warn above a quarter**, which leaves 4x and is
 * roughly where the runner variance alone stops being survivable.
 *
 * The slowest tests are always printed, whether or not anything crossed a line.
 * The thresholds catch drift that has gone too far; the listing is what lets
 * someone notice it a stage earlier.
 */

/** Above this fraction of its timeout, a test fails the run. */
export const HEADROOM_FAIL = 0.5
/** Above this fraction, it is reported as approaching. */
export const HEADROOM_WARN = 0.25
/** How many of the slowest to list, regardless of threshold. */
const LIST = 8

interface Entry {
  readonly title: string
  readonly duration: number
  readonly timeout: number
  readonly ratio: number
}

export default class HeadroomReporter implements Reporter {
  #entries: Entry[] = []

  onTestEnd(test: TestCase, result: TestResult): void {
    // Skipped tests have no duration worth reporting, and a test that timed out
    // is already failing for the right reason.
    if (result.status === 'skipped' || result.status === 'timedOut') return
    const timeout = test.timeout
    if (timeout <= 0) return
    this.#entries.push({
      title: test.titlePath().slice(1).filter(Boolean).join(' › '),
      duration: result.duration,
      timeout,
      ratio: result.duration / timeout,
    })
  }

  onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> | void {
    if (this.#entries.length === 0) return

    const sorted = [...this.#entries].sort((a, b) => b.ratio - a.ratio)
    const breaches = sorted.filter((entry) => entry.ratio > HEADROOM_FAIL)
    const warnings = sorted.filter(
      (entry) => entry.ratio > HEADROOM_WARN && entry.ratio <= HEADROOM_FAIL,
    )

    const line = (entry: Entry): string =>
      `    ${(entry.ratio * 100).toFixed(0).padStart(3)}%  ` +
      `${(entry.duration / 1000).toFixed(1).padStart(6)}s of ` +
      `${(entry.timeout / 1000).toFixed(0).padStart(4)}s   ${entry.title}`

    process.stdout.write('\n  Timeout headroom, slowest first:\n')
    for (const entry of sorted.slice(0, LIST)) process.stdout.write(`${line(entry)}\n`)

    if (warnings.length > 0) {
      process.stdout.write(
        `\n  ${warnings.length} test(s) past ${HEADROOM_WARN * 100}% of timeout. ` +
          'Runner speed on this repository has varied by a factor of three, so this is\n' +
          '  the point at which variance alone can take a test over.\n',
      )
    }

    if (breaches.length > 0) {
      process.stdout.write(
        `\n  FAILED: ${breaches.length} test(s) past ${HEADROOM_FAIL * 100}% of timeout:\n`,
      )
      for (const entry of breaches) process.stdout.write(`${line(entry)}\n`)
      process.stdout.write(
        '\n  Either make the test cheaper or raise its timeout deliberately.\n' +
          '  A test this close to its limit fails on a slow runner and stops running at all,\n' +
          '  which is how the oversized export test passed for two pushes without executing.\n',
      )
      // Only escalates a passing run. A run that is already failing has a more
      // urgent reason, and adding a second would bury the first.
      if (result.status === 'passed') return Promise.resolve({ status: 'failed' as const })
    }
  }
}
