import { createRequire } from "node:module";

import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal as TerminalType } from "@xterm/headless";

interface XtermHeadlessModule
{
    Terminal: new(options?: ITerminalOptions & ITerminalInitOnlyOptions) => TerminalType;
}

const loadCommonJs = createRequire(import.meta.url);
const { Terminal } = loadCommonJs("@xterm/headless") as XtermHeadlessModule;

export interface TuiRendererOptions
{
    cols: number;
    rows: number;
}

export class TuiRenderer
{
    private readonly terminal: TerminalType;
    private pendingWrite: Promise<void> = Promise.resolve();

    public constructor(options: TuiRendererOptions)
    {
        this.terminal = new Terminal({ ...options, allowProposedApi: true });
    }

    public write(data: string): void
    {
        this.pendingWrite = this.pendingWrite.then(() =>
            new Promise<void>((resolve) =>
            {
                this.terminal.write(data, resolve);
            })
        );
    }

    public async flush(): Promise<void>
    {
        await this.pendingWrite;
    }

    public render(): string
    {
        return this.renderFrame();
    }

    private renderFrame(): string
    {
        const lines: string[] = [];

        for (let row = 0; row < this.terminal.buffer.active.length; row++)
        {
            lines.push(this.terminal.buffer.active.getLine(row)?.translateToString(true) ?? "");
        }

        while (lines.at(-1) === "")
        {
            lines.pop();
        }

        return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    }

    public dispose(): void
    {
        this.terminal.dispose();
    }
}
