import { Link } from "@tyvo/core/router";

// Rendered with status 404 for unknown URLs and wherever notFound() is called.
export default function NotFound() {
    return (
        <div className="status">
            <div className="code">404</div>
            <h1>This page could not be found</h1>
            <p>The address may be mistyped, or the page has moved.</p>
            <Link href="/">← Back home</Link>
        </div>
    );
}
