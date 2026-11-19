import type { LayoutProps, Metadata } from "@tyvo/core";
import { Nav } from "@/components/nav";
import "./globals.css";

// Merged into every page below; the template wraps their titles ("User 1 | Tyvo").
export const metadata: Metadata = {
    title: { default: "Tyvo", template: "%s | Tyvo" },
    description: "A TypeScript web framework",
};

export default function RootLayout({ children }: LayoutProps) {
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
            </head>
            <body>
                <Nav />
                <main>{children}</main>
            </body>
        </html>
    );
}
