"use client";

import { href, Link, router, useNavigation, usePathname } from "@tyvo/core/router";
import styles from "./nav.module.css";

// `as const` keeps the literal paths: <Link href> only accepts URLs of pages that exist (checked by the types).
const links = [
    ["/", "Home"],
    ["/users/1", "User 1"],
    ["/users/2", "User 2"],
] as const;

export function Nav() {
    const pathname = usePathname();
    const { pending } = useNavigation();
    return (
        <nav className={styles.nav}>
            <div className={styles.inner}>
                <Link href="/" className={styles.brand}>
                    Tyvo
                </Link>
                {links.map(([to, label]) => (
                    <Link key={to} href={to} aria-current={pathname === to ? "page" : undefined}>
                        {label}
                    </Link>
                ))}
                {/* router.push works anywhere in the browser; href() builds a typed URL from a path and its params. */}
                <button onClick={() => router.push(href("/users/[id]", { id: Math.ceil(Math.random() * 100) }))}>Random user</button>
                {pending && <span className="spinner small" aria-label="Loading" />}
            </div>
        </nav>
    );
}
