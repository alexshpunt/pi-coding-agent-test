<p align="center">
    <img alt="pi-coding-agent-test logo" src="./assets/logo.png" width="200">
</p>

<h1 align="center">pi-coding-agent-test</h1>

<p align="center">Test extensions and tools against a real <a href="https://pi.dev/">Pi Coding Agent</a> process.</p>

## Summary

`pi-coding-agent-test` runs tests against real Pi instead of mocking it. Pi loads your extensions, runs real tools and hooks, creates sessions, changes files, and renders terminal output.

The test controls the initial prompt and scripted assistant responses. It does not fake tool execution or extension behavior. Each run gets a fresh session and workspace, records artifacts, and can be replayed without starting Pi.

Executable behavior contracts live in [`./test/`](./test/); demo scripts live in [`./scripts/`](./scripts/).

## Scenario settings

`PiIntegrationTest` supports explicit `skills`, `systemPrompt`, and `appendSystemPrompt` settings. Skills are loaded from the listed files or directories even though ambient skill discovery is disabled for isolated runs. Use `getSystemPrompt(run)` to inspect the final effective prompt after extension `before_agent_start` handlers have run.

## Raw debugging interface

Raw mode is a debugging view for inspecting runs, not just a test assertion format. It shows complete tool arguments and call IDs, followed by the text result and the full result envelope, including internal `details`, error state and progressive updates. Long payloads are wrapped, not shortened to a preview.

Scripted TUI runs use raw mode by default. Set `rawMode: true` explicitly when needed, or `rawMode: false` to inspect Pi's normal tool panels. Raw shows Pi's parsed tool arguments; it is not a byte-for-byte capture of an HTTP request.

The Pi 0.99.1 runtime checks cover Ubuntu and native Windows in CI, including installed-package launch and PTY cleanup.
On Pi 0.99.1, a process-local Node loading hook installs the renderer on the class used by the bundled CLI. It does not edit the Pi installation and does not run in native mode. The adapter depends on Pi's internal renderer signatures and rejects changed or ambiguous matches instead of silently switching to native rendering.

## Headless scenarios

Set `transport: "rpc"` in `PiIntegrationTest` options to run Pi through JSONL pipes instead of a PTY.
The default is `"tui"`. RPC always starts a fresh process, including when the shared test runner is active.
Use RPC for tool and evaluation scenarios; keep TUI for rendering and interactive UI tests.

RPC keeps the harness trace, effective system prompt, tool results, messages, and session in `run.jsonl`.
`terminalOutput` contains raw RPC stdout; `tuiRenderedOutput` and `frameDelaysMs` are empty.
`tuiSize` remains a placeholder for the shared result shape, not an actual terminal.
The artifact directory also contains `rpc-stdout.jsonl` and `rpc-stderr.log`, including on failure.
Raw rendering and live TUI pacing do not apply. Explicit scripted delays still apply.
Dialog requests fail with an error instead of hanging or inventing a user answer.

See [the executable RPC example](test/examples/rpc.integration.test.ts).

## Installation

Install the test package:

```bash
npm install --save-dev pi-coding-agent-test
```

The package provides the TypeScript API and the `pi-test` CLI. Use it with Vitest, Jest, Mocha, `node:test`, Playwright Test, or another Node.js test runner.

### Install Chromium for browser fixtures

The package pins the Playwright runtime, but installing the package does not download Chromium. Provision the matching browser before using a browser fixture:

```bash
npx playwright install chromium
```

On a Linux machine or container that also needs Chromium's system libraries, run:

```bash
npx playwright install --with-deps chromium
```

From this package's source checkout, the same commands are available as `npm run browser:install` and `npm run browser:install:with-deps`.

If you set `PLAYWRIGHT_BROWSERS_PATH`, use the same value when installing Chromium and when running tests. Behind a proxy, set Playwright's supported `HTTPS_PROXY` environment variable for the install command. Playwright also supports `NODE_EXTRA_CA_CERTS` for a custom certificate authority. Do not put credentials in scripts or committed configuration.

In CI and Docker, provision Chromium during job or image setup. Cache the configured `PLAYWRIGHT_BROWSERS_PATH` when useful, and restore the cache before tests run. Do not rely on an npm postinstall hook to download the browser.

## Prerequisites

- Node.js 22.19 or newer;
- Pi installed with the `pi` executable available on `PATH`.

## Dedicated browser fixture

Import `createBrowserFixture` or `withBrowserFixture` from the package root. The callback helper always closes the fixture, including when the callback throws:

```ts
import { spawn } from "node:child_process";

import { withBrowserFixture } from "pi-coding-agent-test";

await withBrowserFixture(async (fixture) =>
{
    const application = spawn("my-test-application", [], {
        env: fixture.childEnvironment({
            ...process.env,
            BROWSER: fixture.openerCommand,
        }),
        stdio: "inherit",
    });

    try
    {
        const url = await fixture.waitForUrl();
        await fixture.page.goto(url);
        await fixture.page.getByRole("button", { name: "Confirm" }).click();
    }
    finally
    {
        application.kill("SIGTERM");
    }
});
```

Configure the application under test to call `fixture.openerCommand` with one HTTP or HTTPS URL. `childEnvironment()` adds the fixture's isolated opener state without changing `process.env`. Keep the application or decision server running while the page is in use, and stop it normally yourself; the fixture does not own it.

Each fixture owns its Chromium process, isolated browser context, and page. It never opens the system or default browser. Headless mode is the default. Set `{ headless: false }` explicitly for a visible browser; headed Linux runs need a display such as Xvfb.

`close()` is bounded, safe to call more than once, and reports cleanup errors. `withBrowserFixture()` keeps a callback error visible if cleanup also fails. If matching Chromium is missing, fixture creation fails with the recovery command `npx playwright install chromium`.

Use `createBrowserFixture()` instead when its lifetime cannot fit inside one callback. Always call `await fixture.close()` in a `finally` block.

## Install optional Pi skills

```bash
pi install npm:pi-coding-agent-test
```

## Runnable integration tests

From a checkout of this package, run the demonstration integration tests with real Pi:

```bash
npm run test:examples
```

For the interactive terminal demo, watch a real Pi TUI live until you stop it with `Ctrl+C`:

```bash
npm run demo:live
```

To replay the checked-in recording offline:

```bash
npm run demo:replay
```

| Test                                                                               | Covers                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`evaluation-smoke`](./test/examples/evaluation-smoke.integration.test.ts)         | Isolated workspaces, built-in tools, filesystem effects, and artifacts |
| [`extensions`](./test/examples/extensions.integration.test.ts)                     | Custom extensions, tool selection, and runtime registration            |
| [`raw-tooling-renderer`](./test/examples/raw-tooling-renderer.integration.test.ts) | Stable raw tool-call and tool-result rendering                         |
| [`streaming`](./test/examples/streaming.integration.test.ts)                       | Streamed text, partial tool-call JSON, and real tool execution         |
| [`native-tui`](./test/examples/native-tui.integration.test.ts)                     | Pi's native renderer and visible terminal assertions                   |
| [`replay`](./test/examples/replay.integration.test.ts)                             | All built-in tools, large TypeScript edits, and offline replay         |

## Development and releases

Development and releases use this public repository. Open changes against `develop`;
release candidates go to `main`. There is no private publisher or local-registry step.

`runtime.yml` checks Ubuntu and native Windows. `release.yml` validates source tests,
browser behavior and a clean tarball install. Publishing a GitHub Release runs the
npm OIDC publisher on that exact validated archive. A manual workflow run validates
without publishing. npm must trust `alexshpunt/pi-coding-agent-test`, workflow
`release.yml`, with direct publishing allowed.

## Browser package verification

Run `node test/fixtures/verify-browser-package-consumers.mjs preflight` to check prerequisites.
Run the same command with `pack` to build a tarball, install it in a clean project,
and exercise the installed browser fixture. Both commands are bounded and never publish.

## License

[MIT](./LICENSE)
