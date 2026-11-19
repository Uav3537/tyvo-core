"use client";

import { useState } from "react";
import styles from "./counter.module.css";

// "use client" makes this a client component: it is hydrated in the browser and can use state and events.
export function Counter({ initial }: { initial: number }) {
    const [count, setCount] = useState(initial);
    return (
        <button className={styles.counter} onClick={() => setCount(count + 1)}>
            Clicked {count} times
        </button>
    );
}
