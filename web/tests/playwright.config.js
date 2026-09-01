import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // The Python goldens ARE the parity snapshots (no copies); never let
  // --update-snapshots overwrite them from a Playwright run.
  snapshotPathTemplate: '{testDir}/../../packages/relighting_engine/tests/fixtures/expected/{arg}{ext}',
  updateSnapshots: 'none',
  use: {
    headless: true,
    viewport: { width: 1024, height: 768 },
    launchOptions: {
      args: ['--use-gl=swiftshader'],
    },
  },
  webServer: {
    command: 'C:\\dev\\photo-relighting\\.venv\\Scripts\\uvicorn.exe relighting_api.main:app --port 8765',
    url: 'http://localhost:8765/healthz',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
