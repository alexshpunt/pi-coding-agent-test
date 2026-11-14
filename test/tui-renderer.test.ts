import { expect, test } from "vitest";

import { TuiRenderer } from "../src/terminal/renderer.js";

test("serializes the queued terminal state before later writes and restores its cursor", async () =>
{
    const source = new TuiRenderer({ cols: 20, rows: 5 });
    const restored = new TuiRenderer({ cols: 20, rows: 5 });

    try
    {
        source.write("before\r\nfooter\u001B[1;3H");
        const snapshot = source.serialize();
        source.write("X");
        restored.write(await snapshot);
        await restored.flush();
        expect(restored.render()).toBe("before\nfooter\n");

        restored.write("X");
        await Promise.all([source.flush(), restored.flush()]);
        expect(source.render()).toBe("beXore\nfooter\n");
        expect(restored.render()).toBe(source.render());
    }
    finally
    {
        source.dispose();
        restored.dispose();
    }
});
