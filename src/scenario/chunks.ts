/** How a complete provider value is divided into streaming deltas. */
export type ChunkSpec =
    | {
        /** Use the supplied delta sequence exactly. */
        readonly kind: "explicit";

        /** Deltas whose concatenation must equal the complete value. */
        readonly chunks: readonly string[];
    }
    | {
        /** Split the UTF-16 string into fixed-size slices. */
        readonly kind: "fixed";

        /** Positive number of UTF-16 code units in each slice. */
        readonly size: number;
    }
    | {
        /** Split the value by Unicode code point. */
        readonly kind: "characters";
    };

/** Split a complete provider value according to a validated chunk specification. */
export function chunkString(value: string, spec: ChunkSpec): string[]
{
    if (spec.kind === "explicit")
    {
        if (spec.chunks.join("") !== value)
        {
            throw new Error("Explicit chunks must concatenate to the input string");
        }

        return [...spec.chunks];
    }

    if (spec.kind === "characters")
    {
        const chunks: string[] = [];

        for (const character of value)
        {
            chunks.push(character);
        }

        return chunks;
    }

    if (!Number.isInteger(spec.size) || spec.size <= 0)
    {
        throw new Error("Fixed chunk size must be a positive integer");
    }

    const chunks: string[] = [];

    for (let offset = 0; offset < value.length; offset += spec.size)
    {
        chunks.push(value.slice(offset, offset + spec.size));
    }

    return chunks;
}
