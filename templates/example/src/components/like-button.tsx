"use client";

import { useState, useTransition } from "react";
import { like } from "@/actions/likes";

export function LikeButton({ likes }: { likes: number }) {
    const [count, setCount] = useState(likes);
    const [pending, startTransition] = useTransition();
    // like() runs on the server; calling it from the browser sends a request to /_tyvo/action.
    return (
        <button disabled={pending} onClick={() => startTransition(async () => setCount(await like()))}>
            Like ({count})
        </button>
    );
}
