import { LIVE_MODE_ENVIRONMENT } from "../runtime/constants.js";

import {
    BEGIN_SYNCHRONIZED_OUTPUT,
    END_SYNCHRONIZED_OUTPUT,
    synchronizedOutputPrefixLength,
} from "./synchronized-output.js";

const defaultFrameIntervalMs = 17;

const hostInputModeSequences = [
    "\u001B[?2004h",
    "\u001B[?2004l",
    "\u001B[>7u",
    "\u001B[?u",
    "\u001B[c",
    "\u001B[<u",
    "\u001B[>4;2m",
    "\u001B[>4;0m",
] as const;

export class LiveTuiOutput
{
    private buffer = "";
    private cancelled = false;
    private output: Promise<void> = Promise.resolve();
    private lastFrameAt = 0;

    public constructor(private readonly frameIntervalMs: number)
    {
    }

    public write(data: string): void
    {
        if (this.cancelled)
        {
            return;
        }

        let displayData = data;

        for (const sequence of hostInputModeSequences)
        {
            displayData = displayData.replaceAll(sequence, "");
        }

        if (displayData.length === 0)
        {
            return;
        }

        this.buffer += displayData;
        this.extractCompleteFrames();
    }

    public cancel(): void
    {
        this.buffer = "";
        this.cancelled = true;
    }

    public async flush(): Promise<void>
    {
        this.extractCompleteFrames();

        if (this.buffer.length > 0)
        {
            this.enqueue(this.buffer, false);
            this.buffer = "";
        }

        await this.output;
    }

    private extractCompleteFrames(): void
    {
        while (this.buffer.length > 0)
        {
            const frameStart = this.buffer.indexOf(BEGIN_SYNCHRONIZED_OUTPUT);

            if (frameStart === -1)
            {
                const retainedLength = synchronizedOutputPrefixLength(this.buffer);
                const outputLength = this.buffer.length - retainedLength;

                if (outputLength > 0)
                {
                    this.enqueue(this.buffer.slice(0, outputLength), false);
                    this.buffer = this.buffer.slice(outputLength);
                }

                return;
            }

            if (frameStart > 0)
            {
                this.enqueue(this.buffer.slice(0, frameStart), false);
                this.buffer = this.buffer.slice(frameStart);
            }

            const frameEnd = this.buffer.indexOf(
                END_SYNCHRONIZED_OUTPUT,
                BEGIN_SYNCHRONIZED_OUTPUT.length,
            );

            if (frameEnd === -1)
            {
                return;
            }

            const endOffset = frameEnd + END_SYNCHRONIZED_OUTPUT.length;
            this.enqueue(this.buffer.slice(0, endOffset), true);
            this.buffer = this.buffer.slice(endOffset);
        }
    }

    private enqueue(data: string, frame: boolean): void
    {
        this.output = this.output.then(async () =>
        {
            if (this.cancelled)
            {
                return;
            }

            if (frame)
            {
                const elapsed = performance.now() - this.lastFrameAt;
                const wait = Math.max(0, this.frameIntervalMs - elapsed);

                if (wait > 0)
                {
                    await delay(wait);
                }
            }

            await writeOutput(data);

            if (frame)
            {
                this.lastFrameAt = performance.now();
            }

            return;
        });
    }
}

export function createLiveTuiOutput(): LiveTuiOutput | undefined
{
    if (process.env[LIVE_MODE_ENVIRONMENT] !== "1")
    {
        return undefined;
    }

    const value = process.env.PI_INTEGRATION_TEST_DELTA_DELAY_MS;
    const frameIntervalMs = value !== undefined && /^\d+$/u.test(value)
        ? Math.max(defaultFrameIntervalMs, Number(value))
        : defaultFrameIntervalMs;
    return new LiveTuiOutput(frameIntervalMs);
}

function writeOutput(data: string): Promise<void>
{
    return new Promise((resolve) =>
    {
        process.stdout.write(data, () =>
        {
            resolve();
        });
    });
}

function delay(milliseconds: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
