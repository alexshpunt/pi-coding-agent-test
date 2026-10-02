/** A deadline expired before Pi settled; partial artifacts remain a failed run. */
export class RunTimeoutError extends Error
{
    public constructor(message: string)
    {
        super(message);
        this.name = "RunTimeoutError";
    }
}

/** Recognize a deadline through transport wrappers without guessing from error text. */
export function isRunTimeout(error: unknown): boolean
{
    return error instanceof RunTimeoutError
        || (error instanceof Error && error.cause !== undefined && isRunTimeout(error.cause));
}
