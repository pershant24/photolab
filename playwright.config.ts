import { defineConfig, devices } from '@playwright/test'

// Golden images are generated with SwiftShader, not a real GPU, so the browser
// must be forced onto it here and in CI alike. See tests/README.md.
const SWIFTSHADER_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
]

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // The headroom reporter runs in both, because a test drifting toward its
  // timeout is exactly as worth knowing about locally as in CI — and locally is
  // where it is cheap to fix.
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['./tests/support/headroom-reporter.ts']]
    : [['list'], ['./tests/support/headroom-reporter.ts']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
  ],
  webServer: {
    // --host 127.0.0.1 is required: with the default `localhost` bind, vite
    // listens on ::1 only on macOS and the IPv4 baseURL never connects.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
