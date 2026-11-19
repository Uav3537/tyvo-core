import type { LayoutProps, Metadata } from "@tyvo/core";
import "./globals.css";

export const metadata: Metadata = {
    title: { default: "{{name}}", template: "%s | {{name}}" },
    description: "Built with Tyvo",
};

// The root layout wraps every page (and not-found.tsx); it must render <html> and <body>.
export default function RootLayout({ children }: LayoutProps) {
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
            </head>
            <body>{children}</body>
        </html>
    );
}
