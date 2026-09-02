import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // The Python goldens ARE the parity snapshots (no copies); never let
  // --update-snapshots overwrite them from a Playwright run.
  snapshotPathTemplate: '{testDir}/../../packages/relighting_engine/tests/fixtures/expected/{arg}{ext}',
  updateSnapshots: 'none',
  // Every spec creates a scene through a real /prepare on the one local GPU,
  // and the first few also pay the server's model load; with the default
  // worker count those cold runs overlap and the 60 s scene-creation waits
  // time out. One worker keeps the suite deterministic (~4 min).
  workers: 1,
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
