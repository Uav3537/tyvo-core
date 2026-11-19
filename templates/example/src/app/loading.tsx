// Shown while a page below this folder is still rendering (a Suspense boundary).
export default function Loading() {
    return (
        <div className="status" aria-busy="true">
            <div className="spinner" />
            <p>Loading...</p>
        </div>
    );
}
