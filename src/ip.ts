import { z } from "zod";
import type { TyvoConfig } from "./types.js";

const IP = z.union([z.ipv4(), z.ipv6()]);

/** `::ffff:127.0.0.1` (IPv4-mapped IPv6, as Node reports IPv4 clients on dual-stack sockets) -> `127.0.0.1`. */
export function normalizeIp(ip: string): string {
    const trimmed = ip.trim();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
    return mapped ? mapped[1]! : trimmed;
}

export function isIp(value: unknown): value is string {
    return IP.safeParse(value).success;
}

/** `request.ip`: whatever `getIp(request, socketIp)` in config.ts returns, which must be an IPv4/IPv6 address. */
export async function resolveIp(config: TyvoConfig, request: Request, socketIp: string): Promise<string> {
    const ip: unknown = await config.getIp(request, socketIp);
    if (!isIp(ip)) throw new TypeError(`getIp() in config.ts returned ${JSON.stringify(ip)}, which is not an IPv4/IPv6 address.`);
    return ip;
}
