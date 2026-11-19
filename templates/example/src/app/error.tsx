"use client";

// Catches errors thrown while rendering pages below this folder. reset() re-renders them.
export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
    return (
        <div className="status" role="alert">
            <h1>Something went wrong</h1>
            <p>{error.message}</p>
            <button onClick={reset}>Try again</button>
        </div>
    );
}
