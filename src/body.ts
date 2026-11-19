import { HttpError } from "./response.js";

/** Turns a request body into a value. Receives a clone, so the original body stays readable. */
export type Parser<T = unknown> = (request: Request) => Promise<T>;

export interface BodyParserOptions {
    /** Maximum body size in bytes. Larger bodies are rejected with 413. */
    limit: number;
}

/** Form fields: repeated names become arrays, file inputs stay `File`s. */
export type FormFields = Record<string, FormDataEntryValue | FormDataEntryValue[]>;

/**
 * Parses by `Content-Type` only — no guessing from the content:
 * - `application/json`, `*+json` -> parsed JSON (`undefined` for an empty body)
 * - `application/x-www-form-urlencoded`, `multipart/form-data` -> {@link FormFields}
 * - `text/*` -> string
 * - anything else -> `Uint8Array`
 */
export function bodyParser(options: BodyParserOptions): Parser {
    const { limit } = options;
    if (!(limit > 0)) throw new TypeError("bodyParser(): `limit` must be a positive number of bytes.");
    return async (request) => {
        if (request.body === null) return undefined;

        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
        const bytes = await readLimited(request.body, limit);

        const contentType = request.headers.get("content-type") ?? "";
        const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();

        if (mime === "application/json" || mime.endsWith("+json")) {
            if (bytes.length === 0) return undefined;
            try {
                return JSON.parse(new TextDecoder().decode(bytes));
            } catch {
                throw new HttpError(400, "Malformed JSON body");
            }
        }
        if (mime === "application/x-www-form-urlencoded") {
            return toFields(new URLSearchParams(new TextDecoder().decode(bytes)));
        }
        if (mime === "multipart/form-data") {
            try {
                return toFields(await new Response(bytes, { headers: { "content-type": contentType } }).formData());
            } catch {
                throw new HttpError(400, "Malformed multipart body");
            }
        }
        if (mime.startsWith("text/")) return new TextDecoder().decode(bytes);
        return bytes;
    };
}

/** Reads a whole body, failing with 413 once it grows past `limit` bytes. */
export async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            throw tooLarge(limit);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function toFields(entries: Iterable<[string, FormDataEntryValue]>): FormFields {
    const fields: FormFields = {};
    for (const [name, value] of entries) {
        const existing = fields[name];
        if (existing === undefined) fields[name] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else fields[name] = [existing, value];
    }
    return fields;
}

function tooLarge(limit: number): HttpError {
    return new HttpError(413, `Request body exceeds ${limit} bytes`);
}
