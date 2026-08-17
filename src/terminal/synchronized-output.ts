export const BEGIN_SYNCHRONIZED_OUTPUT = "\u001B[?2026h";

export const END_SYNCHRONIZED_OUTPUT = "\u001B[?2026l";

export class SynchronizedFrameExtractor
{
    private buffer = "";

    public write(data: string): readonly string[]
    {
        this.buffer += data;
        const frames: string[] = [];

        while (this.buffer.length > 0)
        {
            const frameStart = this.buffer.indexOf(BEGIN_SYNCHRONIZED_OUTPUT);

            if (frameStart === -1)
            {
                const retainedLength = synchronizedOutputPrefixLength(this.buffer);
                this.buffer = retainedLength === 0 ? "" : this.buffer.slice(-retainedLength);
                return frames;
            }

            if (frameStart > 0)
            {
                this.buffer = this.buffer.slice(frameStart);
            }

            const frameEnd = this.buffer.indexOf(
                END_SYNCHRONIZED_OUTPUT,
                BEGIN_SYNCHRONIZED_OUTPUT.length,
            );

            if (frameEnd === -1)
            {
                return frames;
            }

            const endOffset = frameEnd + END_SYNCHRONIZED_OUTPUT.length;
            frames.push(this.buffer.slice(0, endOffset));
            this.buffer = this.buffer.slice(endOffset);
        }

        return frames;
    }
}

export function synchronizedFrameEndOffsets(stream: string): number[]
{
    const offsets: number[] = [];
    let searchOffset = 0;

    while (true)
    {
        const frameStart = stream.indexOf(BEGIN_SYNCHRONIZED_OUTPUT, searchOffset);

        if (frameStart === -1)
        {
            return offsets;
        }

        const frameEnd = stream.indexOf(
            END_SYNCHRONIZED_OUTPUT,
            frameStart + BEGIN_SYNCHRONIZED_OUTPUT.length,
        );

        if (frameEnd === -1)
        {
            return offsets;
        }

        searchOffset = frameEnd + END_SYNCHRONIZED_OUTPUT.length;
        offsets.push(searchOffset);
    }
}

export function synchronizedOutputPrefixLength(value: string): number
{
    const maximum = Math.min(value.length, BEGIN_SYNCHRONIZED_OUTPUT.length - 1);

    for (let length = maximum; length > 0; length -= 1)
    {
        if (BEGIN_SYNCHRONIZED_OUTPUT.startsWith(value.slice(-length)))
        {
            return length;
        }
    }

    return 0;
}
