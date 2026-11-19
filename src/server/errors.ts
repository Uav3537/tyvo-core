import { toErrorResponse } from "../pipeline.js";
import { getRuntime } from "../runtime.js";

/** Runs an error through onError in config.ts (redirect()/notFound() included) and builds the Response. */
export async function errorToResponse(error: unknown, request: Request): Promise<Response> {
    return (await toErrorResponse(getRuntime().config.onError, error, request))._build();
}
