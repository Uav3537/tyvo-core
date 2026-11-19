// Console output of the CLI, in the same Next.js-like style as nextLogger() (which config.ts uses at runtime).
import { appFileOf } from "../shared/conventions.js";

const colors = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (colors ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);
export const magenta = paint(35);

export const ok = (message: string) => console.log(` ${green("✓")} ${message}`);
export const progress = (message: string) => console.log(` ${cyan("○")} ${message}`);
export const warn = (message: string) => console.warn(` ${yellow("⚠")} ${message}`);
export const fail = (message: string) => console.error(` ${red("⨯")} ${message}`);

export function formatDuration(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function banner(version: string, lines: [string, string][]): void {
    console.log([`   ${magenta(bold("▲ Tyvo " + version))}`, ...lines.map(([label, value]) => `   - ${(label + ":").padEnd(14)}${value}`), ""].join("\n"));
}

interface RouteRow {
    /** e.g. `/blog/[slug]` */
    path: string;
    symbol: "○" | "●" | "ƒ";
    /** Prerendered paths of a page with staticParams(). */
    children: string[];
}

/** The route table printed after `tyvo build`, like `next build`. */
export function routeTable(files: string[], prerendered: Map<string, string[]>): void {
    const rows: RouteRow[] = [];
    for (const file of files) {
        const appFile = appFileOf(file);
        if (!appFile) continue;
        const parts = appFile.dir.split("/").filter(Boolean);
        if (parts.some((part) => part.startsWith("_"))) continue;
        const path = "/" + parts.filter((part) => !(part.startsWith("(") && part.endsWith(")"))).join("/");
        const paths = prerendered.get(file);
        const dynamic = parts.some((part) => part.startsWith("["));
        const symbol = !paths ? "ƒ" : dynamic ? "●" : "○";
        rows.push({ path, symbol, children: dynamic && paths ? paths : [] });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));

    const lines = [bold("Route")];
    rows.forEach((row, i) => {
        const last = i === rows.length - 1;
        lines.push(`${rows.length === 1 ? "─" : i === 0 ? "┌" : last ? "└" : "├"} ${row.symbol} ${row.path}`);
        row.children.forEach((child, j) => lines.push(`${last ? " " : "│"}   ${j === row.children.length - 1 ? "└" : "├"} ${dim(child)}`));
    });
    const used = new Set(rows.map((row) => row.symbol));
    lines.push("");
    if (used.has("○")) lines.push(`○  (Static)   prerendered as static content`);
    if (used.has("●")) lines.push(`●  (SSG)      prerendered with staticParams()`);
    if (used.has("ƒ")) lines.push(`ƒ  (Dynamic)  rendered on demand`);
    console.log("\n" + lines.join("\n") + "\n");
}
