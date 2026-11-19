// Types for files imported from code. Referenced by the tyvo-env.d.ts that `tyvo init` creates:
//   /// <reference types="@tyvo/core/assets" />

/**
 * Stylesheets (added to every page). For `*.module.css` (CSS Modules) the default export maps class names to
 * their scoped names; TypeScript can't tell the two patterns apart, so both share this declaration.
 */
declare module "*.css" {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}

// Images, fonts and media: the import is the file's URL (hashed, served from /_tyvo/static/).
declare module "*.png" {
    const url: string;
    export default url;
}
declare module "*.jpg" {
    const url: string;
    export default url;
}
declare module "*.jpeg" {
    const url: string;
    export default url;
}
declare module "*.gif" {
    const url: string;
    export default url;
}
declare module "*.webp" {
    const url: string;
    export default url;
}
declare module "*.avif" {
    const url: string;
    export default url;
}
declare module "*.svg" {
    const url: string;
    export default url;
}
declare module "*.ico" {
    const url: string;
    export default url;
}
declare module "*.woff" {
    const url: string;
    export default url;
}
declare module "*.woff2" {
    const url: string;
    export default url;
}
declare module "*.ttf" {
    const url: string;
    export default url;
}
declare module "*.otf" {
    const url: string;
    export default url;
}
declare module "*.mp4" {
    const url: string;
    export default url;
}
declare module "*.webm" {
    const url: string;
    export default url;
}
declare module "*.mp3" {
    const url: string;
    export default url;
}
declare module "*.wav" {
    const url: string;
    export default url;
}
