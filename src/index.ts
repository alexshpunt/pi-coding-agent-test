/**
 * Framework-independent API for deterministic real-process Pi tests.
 *
 * @packageDocumentation
 */
export { type ChunkSpec, chunkString } from "./scenario/chunks.js";

export {
    emitMessageUpdateEvents,
    generateToolCallEvents,
    type MessageUpdateEvent,
    type MessageUpdateHandler,
    type PartialToolCallBlock,
    type ToolCallDeltaEvent,
    type ToolCallEndEvent,
    type ToolCallEvent,
    type ToolCallInput,
    type ToolCallStartEvent,
} from "./scenario/tool-call-events.js";

export {
    type AssistantContentBlock,
    assistantMessage,
    type AssistantMessageScenario,
    type PiIntegrationTestArtifacts,
    type PiIntegrationTestModel,
    type PiIntegrationTestOptions,
    type PiIntegrationTestProviderMode,
    type PiIntegrationTestResult,
    type PiIntegrationTestState,
    type PiIntegrationTestThinkingLevel,
    type StopReason,
    text,
    type TextBlock,
    toolCall,
    type ToolCallBlock,
    type ToolSelection,
    type TraceEvent,
    type TuiSize,
} from "./scenario/types.js";

export { testArtifactsDir } from "./runtime/artifacts.js";

export {
    type BrowserFixture,
    type BrowserFixtureOptions,
    type BrowserFixtureWaitOptions,
    createBrowserFixture,
    withBrowserFixture,
} from "./browser-fixture.js";

export { PiIntegrationTest } from "./runtime/integration-test.js";

export { PiRun } from "./runtime/run.js";

export {
    getProviderRequestLastMessageText,
    getProviderSystemPrompt,
    getSystemPrompt,
    getToolCallNames,
    getToolExecution,
    getToolExecutionDetails,
    getToolExecutionResult,
    getToolExecutions,
    getToolResultMessage,
    getToolResultText,
    type PiIntegrationTestInspection,
    type ToolExecutionTrace,
} from "./runtime/result-accessors.js";
