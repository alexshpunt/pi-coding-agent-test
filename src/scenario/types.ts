import type { ChunkSpec } from "./chunks.js";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/** The provider stop reason returned after one scripted assistant message. */
export type StopReason = "stop" | "length" | "toolUse";

/** A scripted assistant text block and its optional streaming schedule. */
export interface TextBlock
{
    /** Discriminator used by the scripted provider. */
    readonly type: "text";

    /** Complete text returned by the block. */
    readonly text: string;

    /** How the complete text is divided into provider deltas. Defaults to characters. */
    readonly chunks?: ChunkSpec;

    /** Delay before each delta. The array length must match the generated chunk count. */
    readonly deltaDelaysMs?: readonly number[];

    /** Fixed delay before every delta when `deltaDelaysMs` is not set. Defaults to 1 ms. */
    readonly delayMs?: number;
}

/** A scripted assistant tool call and its optional partial-argument stream. */
export interface ToolCallBlock
{
    /** Discriminator used by the scripted provider. */
    readonly type: "toolCall";

    /** Stable tool-call identifier used by later assertions. */
    readonly id: string;

    /** Registered Pi tool name. */
    readonly name: string;

    /** Complete tool arguments. Use either this field or `argumentsJson`. */
    readonly arguments?: Readonly<Record<string, unknown>>;

    /** Exact serialized arguments when malformed or partial JSON is part of the scenario. */
    readonly argumentsJson?: string;

    /** How the serialized arguments are divided into provider deltas. Defaults to characters. */
    readonly chunks?: ChunkSpec;

    /** Delay before each argument delta. The array length must match the generated chunk count. */
    readonly deltaDelaysMs?: readonly number[];

    /** Parsed arguments exposed with each delta when progressive rendering needs exact snapshots. */
    readonly argumentSnapshots?: readonly Readonly<Record<string, unknown>>[];

    /** Assistant content index for providers that interleave text and tool calls. */
    readonly contentIndex?: number;

    /** Set to `false` to end the provider stream before the `toolcall_end` event. */
    readonly includeEnd?: boolean;

    /** Fixed delay before every delta when `deltaDelaysMs` is not set. Defaults to 1 ms. */
    readonly delayMs?: number;
}

/** A text or tool-call block in one scripted assistant message. */
export type AssistantContentBlock = TextBlock | ToolCallBlock;

/** One complete assistant response returned for the next real provider request. */
export interface AssistantMessageScenario
{
    /** Ordered text and tool-call blocks in the response. */
    readonly blocks: readonly AssistantContentBlock[];

    /** Provider stop reason. Defaults to `stop`. */
    readonly stopReason?: StopReason;

    /** Delay before the provider emits the message start event. */
    readonly delayMs?: number;
}

/**
 * Active tools for the real Pi session.
 *
 * Use `all`, an exact allowlist, or an include/exclude filter over all registered tools.
 */
export type ToolSelection = "all" | readonly string[] | {
    /** Optional allowlist. Omit it to start from every registered tool. */
    readonly include?: readonly string[];

    /** Tool names removed after applying `include`. */
    readonly exclude?: readonly string[];
};

/** Model source used by a real-Pi scenario. */
export type PiIntegrationTestProviderMode = "scripted" | "user";

/** Reasoning level passed to Pi when the scenario selects one explicitly. */
export type PiIntegrationTestThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Configuration for one real-Pi scenario. */
export interface PiIntegrationTestOptions
{
    /** Stable artifact directory name. Unsafe filename characters are replaced with `-`. */
    readonly testName: string;

    /** PTY dimensions. Custom sizes use a standalone Pi process. Defaults to 160 by 50. */
    readonly tuiSize?: TuiSize;

    /** Process transport. Defaults to `tui`; `rpc` uses pipes without a terminal or frame capture. */
    readonly transport?: "tui" | "rpc";

    /** Working directory for Pi and every real tool execution. Defaults to `process.cwd()`. */
    readonly cwd?: string;

    /** Root directory that receives `<testName>/`. Defaults to `.tmp/test-runs`. */
    readonly artifactsDir?: string;

    /** Extension files or package specifiers loaded after the harness extension. */
    readonly extensions?: readonly string[];

    /** Skill files or directories loaded explicitly after discovery is disabled. */
    readonly skills?: readonly string[];

    /** Replace Pi's generated system prompt for this scenario. */
    readonly systemPrompt?: string;

    /** Text appended to Pi's generated system prompt. */
    readonly appendSystemPrompt?: readonly string[];

    /** Active tool selection. Omitted or "all" preserves the session's active tools; exclude-only selections filter that set. Explicit names can enable registered inactive tools. */
    readonly tools?: ToolSelection;

    /** Successive assistant messages used in `scripted` mode. */
    readonly conversation?: readonly AssistantMessageScenario[];

    /** Use the deterministic provider or the user's normal Pi provider. Defaults to `scripted`. */
    readonly providerMode?: PiIntegrationTestProviderMode;

    /** Pi model selector. Scripted mode defaults to `scripted/scripted-model`; user mode may omit it. */
    readonly model?: string;

    /** Explicit Pi reasoning level. User mode may omit it to keep the user's current setting. */
    readonly thinking?: PiIntegrationTestThinkingLevel;

    /** Pi executable path or command name. Defaults to `pi`. */
    readonly piCommand?: string;

    /** Environment values merged over the parent process for the Pi child. */
    readonly environment?: NodeJS.ProcessEnv;

    /** Disable ambient resources and use only the current credentials and model metadata. */
    readonly isolateUserResources?: boolean;

    /** Use one stable raw renderer for every tool. Defaults to `true` in scripted mode and `false` in user mode. */
    readonly rawMode?: boolean;

    /** Maximum time to wait for the real agent to settle. Defaults to 30 seconds. */
    readonly timeoutMs?: number;
}

/** Terminal dimensions used by the real Pi pseudo-terminal. */
export interface TuiSize
{
    /** Terminal width in columns. */
    readonly cols: number;

    /** Terminal height in rows. */
    readonly rows: number;
}

/** One ordered JSONL event recorded by the harness extension. */
export interface TraceEvent
{
    /** Harness event name, such as `provider_request` or `tool_execution_end`. */
    readonly type: string;

    /** Zero-based order within the current scenario. */
    readonly sequence: number;

    /** Wall-clock time in Unix milliseconds. */
    readonly timestamp: number;

    /** Host monotonic milliseconds for elapsed-time comparisons; absent in older traces. */
    readonly monotonicMs?: number;

    /** Event-specific data recorded by the harness. */
    readonly [key: string]: unknown;
}

/** Public files written for one integration run. */
export interface PiIntegrationTestArtifacts
{
    /** Directory containing the run artifact. */
    readonly directory: string;

    /** Startup or execution failure details, when the run fails. */
    readonly error: string;

    /** Canonical machine-readable run bundle. */
    readonly run: string;

    /** Final readable terminal buffer after applying ANSI control sequences. */
    readonly tuiRenderedOutput: string;
}

/** Provider and model identity captured after Pi settles. */
export interface PiIntegrationTestModel
{
    /** Provider identifier. */
    readonly provider: string;

    /** Model identifier. */
    readonly id: string;
}

/** Real session and runtime state captured from the final `agent_settled` event. */
export interface PiIntegrationTestState
{
    /** Pi run mode. Real integration runs use `tui`. */
    readonly mode: "tui" | "rpc" | "json" | "print";

    /** Effective working directory reported by Pi. */
    readonly cwd: string;

    /** Whether Pi considered the agent idle at the snapshot boundary. */
    readonly isIdle: boolean;

    /** Whether queued steering or follow-up messages remained. */
    readonly hasPendingMessages: boolean;

    /** Real Pi session identifier. */
    readonly sessionId: string;

    /** Real session file, when the session is persisted. */
    readonly sessionFile: string | undefined;

    /** Current leaf entry in the session tree. */
    readonly leafId: string | null;

    /** Active provider and model, when one is selected. */
    readonly model: PiIntegrationTestModel | undefined;

    /** Effective reasoning level reported by Pi. */
    readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

    /** Context usage at the settlement boundary, when Pi can calculate it. */
    readonly contextUsage: ContextUsage | undefined;
}

/** Structural data exposed by a completed {@link PiRun}. */
export interface PiIntegrationTestResult
{
    /** Stable paths to the run artifacts. */
    readonly artifacts: PiIntegrationTestArtifacts;

    /** Recorded delay before each synchronized terminal frame, in milliseconds. */
    readonly frameDelaysMs: readonly number[];

    /** Dimensions of the pseudo-terminal used for the run. */
    readonly tuiSize: TuiSize;

    /** Final readable terminal buffer. */
    readonly tuiRenderedOutput: string;

    /** Exact pseudo-terminal output, including ANSI control sequences. */
    readonly terminalOutput: string;

    /** All ordered harness events. */
    readonly traceEvents: readonly TraceEvent[];

    /** Provider requests captured during the run. */
    readonly providerRequests: readonly TraceEvent[];

    /** Messages reconstructed from the final real session branch. */
    readonly messages: readonly unknown[];

    /** Final session and runtime state, or `undefined` if Pi could not capture a snapshot. */
    readonly state: PiIntegrationTestState | undefined;

    /** Standalone Pi exit code. Shared-runner scenarios return `null`. */
    readonly exitCode: number | null;
}

/** Create a scripted text block.
 *
 * @example
 * ```ts
 * text("Hello", { chunks: { kind: "fixed", size: 2 }, delayMs: 5 });
 * ```
 */
export function text(value: string, options: Omit<TextBlock, "type" | "text"> = {}): TextBlock
{
    return { type: "text", text: value, ...options };
}

/** Create a scripted tool call and validate that exactly one argument representation is present.
 *
 * @example
 * ```ts
 * toolCall({ id: "call-1", name: "read", arguments: { path: "README.md" } });
 * ```
 */
export function toolCall(input: Omit<ToolCallBlock, "type">): ToolCallBlock
{
    if (input.arguments === undefined && input.argumentsJson === undefined)
    {
        throw new Error("A tool call requires arguments or argumentsJson");
    }

    if (input.arguments !== undefined && input.argumentsJson !== undefined)
    {
        throw new Error("A tool call cannot define both arguments and argumentsJson");
    }

    return { type: "toolCall", ...input };
}

/** Create one scripted assistant response from ordered content blocks.
 *
 * @example
 * ```ts
 * assistantMessage([
 *     text("Done"),
 * ], { stopReason: "stop" });
 * ```
 */
export function assistantMessage(
    blocks: readonly AssistantContentBlock[],
    options: Omit<AssistantMessageScenario, "blocks"> = {},
): AssistantMessageScenario
{
    return { blocks, ...options };
}
