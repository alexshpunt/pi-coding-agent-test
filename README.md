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

`PiIntegrationTest` supports explicit `skills`, `systemPrompt`, and `appendSystemPrompt` settings. Skills are loaded from the listed files or directories even though ambient skill discovery is disabled for isolated runs.

## Installation

Install the test package:

```bash
npm install --save-dev pi-coding-agent-test
```

The package provides the TypeScript API and the `pi-test` CLI. Use it with Vitest, Jest, Mocha, `node:test`, Playwright Test, or another Node.js test runner.

## Prerequisites

- Node.js 22.19 or newer;
- Pi installed with the `pi` executable available on `PATH`.

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

## License

[MIT](./LICENSE)
