import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import type * as TS from "typescript";
import { TYPES_DIR } from "./typegen.js";

/**
 * Type-checks the project with its own TypeScript install. Tyvo's rules are part of it: they live in the generated
 * `.tyvo/types/check.ts` (write it first with `writeTypes`), so this is the same check `tsc` and the editor do.
 * Errors of that file are printed at the file and line they are about, not at the generated check.
 */
export function check(root: string): { errors: number; warnings: number } {
    const ts = loadTypeScript(root);
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    if (!configPath) throw new Error(`No tsconfig.json found in ${root}.`);

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, { noEmit: true }, configPath);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
    const checkFile = resolve(root, TYPES_DIR, "check.ts");
    const diagnostics: TS.Diagnostic[] = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) =>
        diagnostic.file && resolve(diagnostic.file.fileName) === checkFile ? toSource(ts, program, root, diagnostic) : diagnostic,
    );

    if (diagnostics.length) {
        const host: TS.FormatDiagnosticsHost = {
            getCanonicalFileName: (f) => f,
            getCurrentDirectory: () => root,
            getNewLine: () => ts.sys.newLine,
        };
        const format = process.stdout.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics;
        console.log(format(diagnostics, host));
    }
    return {
        errors: diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length,
        warnings: diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning).length,
    };
}

const PAGE_EXPORTS = "metadata|generateMetadata|prerender|revalidate|staticParams";

/**
 * A diagnostic of `.tyvo/types/check.ts`, moved to what it is about. Rule checks fail as
 * `Type '"<file>: <message>"' is not assignable to type '"ok"'`; the config check as an assignment to TyvoConfig.
 */
function toSource(ts: typeof TS, program: TS.Program, root: string, diagnostic: TS.Diagnostic): TS.Diagnostic {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const rule = /^Type '"(.*)"' is not assignable to type '"ok"'\./s.exec(text);
    if (rule) {
        const message = JSON.parse(`"${rule[1]!}"`) as string;
        // "<file>: ...": a source file (with an extension), or any file under public/ (which may have none).
        const target = /^(public\/[^\s:]+|[^\s:]+?\.[a-z0-9]+): /i.exec(message);
        const file = target && sourceOf(ts, program, root, target[1]!);
        // The file may be gone or unreadable: keep the message, without a location.
        if (!file) return { ...diagnostic, file: undefined, start: undefined, length: undefined, messageText: message };
        const at = exportNamed(ts, file, exportOf(message));
        return { ...diagnostic, file, start: at?.getStart(file) ?? 0, length: at ? at.getEnd() - at.getStart(file) : 0, messageText: message.slice(target[0].length) };
    }
    // `configCheck: TyvoConfig = config`: point at the setting that is wrong (or the top of config.ts if it is missing).
    if (/TyvoConfig/.test(text)) {
        const configName = ["config.ts", "config.tsx"].find((name) => existsSync(join(root, name)));
        const file = configName && sourceOf(ts, program, root, configName);
        if (file) {
            const property = /Types of property '(\w+)' are incompatible/.exec(text)?.[1];
            const at = property ? exportNamed(ts, file, property) : undefined;
            const missing = /Property '(\w+)' is missing/.exec(text)?.[1];
            // Drop the first line (`typeof import("…/config")` is not assignable to TyvoConfig): the rest says what is wrong.
            const detail = text.split("\n").slice(property ? 2 : 1).map((line) => line.trim()).join(" ");
            const messageText = missing
                ? `Missing setting "${missing}": config.ts must export every setting (Tyvo has no hidden defaults).`
                : property
                  ? `Setting "${property}" has the wrong type: ${detail}`
                  : diagnostic.messageText;
            return { ...diagnostic, file, start: at?.getStart(file) ?? 0, length: at ? at.getEnd() - at.getStart(file) : 0, messageText };
        }
    }
    return diagnostic;
}

/** Which export a rule message is about: a name, "default", or undefined (the whole file). */
function exportOf(message: string): string | undefined {
    return (
        /"(\w+)" is not a valid export/.exec(message)?.[1] ??
        /: (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (?:must|declares)/.exec(message)?.[1] ??
        /of (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) is not a dynamic segment/.exec(message)?.[1] ??
        new RegExp(`"(${PAGE_EXPORTS})"`).exec(message)?.[1] ??
        new RegExp(`(?:^|: )(${PAGE_EXPORTS.split("|").filter((name) => name !== "metadata").join("|")}) `).exec(message)?.[1] ??
        (/default export|page\(\) declares|has dynamic segments, so a prerendered/.test(message) && !/needs a default export/.test(message)
            ? /has dynamic segments/.test(message)
                ? "prerender"
                : "default"
            : undefined)
    );
}

function sourceOf(ts: typeof TS, program: TS.Program, root: string, file: string): TS.SourceFile | undefined {
    const path = resolve(root, file);
    if (!path.startsWith(resolve(root) + sep)) return undefined;
    const fromProgram = program.getSourceFile(path) ?? program.getSourceFile(path.split(sep).join("/"));
    if (fromProgram) return fromProgram;
    if (!existsSync(path)) return undefined;
    // public/ files (images, videos...) are only named, never read: the message points at their first line.
    if (file.split(sep).join("/").startsWith("public/")) return ts.createSourceFile(path, "", ts.ScriptTarget.Latest, true);
    // Not part of the program (a .js or .txt in src/app/): show it from its own text.
    return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

/** The name of a top-level export (`export const NAME`, `export function NAME`, `export { NAME }`, `export default`). */
function exportNamed(ts: typeof TS, file: TS.SourceFile, name: string | undefined): TS.Node | undefined {
    if (!name) return undefined;
    for (const statement of file.statements) {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (name === "default" && (ts.isExportAssignment(statement) || (exported && isDefault))) return statement;
        if (!exported || isDefault) {
            if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                const element = statement.exportClause.elements.find((e) => e.name.text === name);
                if (element) return element;
            }
            continue;
        }
        if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
            if (declaration) return declaration.name;
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
            return statement.name;
        }
    }
    return undefined;
}

function loadTypeScript(root: string): typeof TS {
    try {
        return createRequire(join(root, "package.json"))("typescript");
    } catch {
        throw new Error(`"typescript" is not installed in ${root}. Run: npm install -D typescript`);
    }
}
