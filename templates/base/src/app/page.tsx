import styles from "./page.module.css";

// Filled in by tyvo init.
const APP_NAME = "{{name}}";
const TYVO_VERSION = "{{tyvoVersion}}";

const cards = [
    {
        title: "Pages",
        body: "React Server Components. Folders are URL segments: users/[id]/page.tsx serves /users/:id.",
        file: "src/app/page.tsx",
    },
    {
        title: "API routes",
        body: "Export GET, POST, ... from route.ts. route() adds validation, rate limits and middlewares.",
        file: "src/app/<path>/route.ts",
    },
    {
        title: "Layouts",
        body: "layout.tsx wraps every page below it. The root one renders <html> and <body>.",
        file: "src/app/layout.tsx",
    },
    {
        title: "Config",
        body: "No hidden defaults: CORS, CSP, rate limits, cookies and logging are all spelled out.",
        file: "config.ts",
    },
];

// src/app/page.tsx is "/". Pages are React Server Components: they run on the server only and may be async.
export default function HomePage() {
    return (
        <main className={"container " + styles.page}>
            <header className={styles.hero}>
                <div className={styles.brand}>
                    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
                        <rect width="32" height="32" rx="8" fill="currentColor" />
                        <path d="M10 11h12M16 11v11" stroke="var(--bg)" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    {APP_NAME}
                </div>
                <h1 className={styles.title}>Your Tyvo app is running.</h1>
                <p className={styles.lead}>
                    Get started by editing <code>src/app/page.tsx</code>. Save the file and this page updates.
                </p>
            </header>

            <section className={styles.grid}>
                {cards.map((card) => (
                    <article key={card.title} className={styles.card}>
                        <h2>{card.title}</h2>
                        <p>{card.body}</p>
                        <code>{card.file}</code>
                    </article>
                ))}
            </section>

            <footer className={styles.footer}>
                <span>
                    The full guide is in <code>TYVO.md</code>.
                </span>
                <span>Tyvo {TYVO_VERSION} · rendered on the server at {new Date().toLocaleTimeString("en-US")}</span>
            </footer>
        </main>
    );
}
