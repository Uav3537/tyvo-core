import type { Metadata } from "@tyvo/core";
import { Link } from "@tyvo/core/router";
import { Counter } from "@/components/counter";
import { LikeButton } from "@/components/like-button";
import { Visits } from "@/components/visits";
import { getLikes } from "@/actions/likes";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Home" };

// Pages are React Server Components: they run on the server only and may be async.
export default async function HomePage() {
    return (
        <div className={"container " + styles.page}>
            <header className={styles.hero}>
                <h1 className={styles.title}>Hello from Tyvo</h1>
                <p className={styles.lead}>
                    Every piece below lives in this project. Edit it and the page updates without losing client state.
                </p>
            </header>

            <section className={styles.grid + " " + styles.wide}>
                <article className={styles.card}>
                    <h2>Server component</h2>
                    <p>This page ran on the server at {new Date().toLocaleTimeString("en-US")}.</p>
                    <code>src/app/page.tsx</code>
                </article>
                <article className={styles.card}>
                    <h2>Client component</h2>
                    <p>"use client" components hydrate in the browser and keep state.</p>
                    <Counter initial={1} />
                </article>
                <article className={styles.card}>
                    <h2>Server action</h2>
                    <p>like() runs on the server, called straight from a button.</p>
                    <LikeButton likes={await getLikes()} />
                </article>
                <Link href="/users/1" className={styles.card}>
                    <h2>Dynamic route →</h2>
                    <p>users/[id]/page.tsx with a typed loader, middlewares and metadata.</p>
                    <code>/users/1</code>
                </Link>
                <a href="/api/hello" className={styles.card}>
                    <h2>API route →</h2>
                    <p>A hand-written GET handler returning JSON.</p>
                    <code>/api/hello</code>
                </a>
                <article className={styles.card}>
                    <h2>Typed API</h2>
                    <p>api() calls /api/session (signed cookies) with its request and response types.</p>
                    <Visits />
                </article>
            </section>
        </div>
    );
}
