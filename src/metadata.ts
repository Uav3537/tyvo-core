// Document metadata for layouts and pages: `export const metadata` / `export async function generateMetadata()`
// (or page({ metadata })). Tyvo renders it as <title>/<meta>/<link>, which React hoists into <head>.

export interface MetadataImage {
    url: string;
    width?: number;
    height?: number;
    alt?: string;
}

export interface Metadata {
    /** A string, or `{ default, template }` in a layout: `template: "%s | My Site"` wraps the titles of pages below it. */
    title?: string | { default: string; template?: string } | { absolute: string };
    description?: string;
    keywords?: readonly string[];
    authors?: readonly { name: string; url?: string }[];
    robots?: string | { index?: boolean; follow?: boolean };
    themeColor?: string;
    alternates?: { canonical?: string; languages?: Readonly<Record<string, string>> };
    icons?: { icon?: string | readonly string[]; apple?: string };
    openGraph?: {
        title?: string;
        description?: string;
        url?: string;
        siteName?: string;
        locale?: string;
        type?: "website" | "article" | "profile" | "book";
        images?: readonly (string | MetadataImage)[];
    };
    twitter?: {
        card?: "summary" | "summary_large_image" | "app" | "player";
        site?: string;
        creator?: string;
        title?: string;
        description?: string;
        images?: readonly string[];
    };
    /** Any other `<meta name content>` pairs. */
    other?: Readonly<Record<string, string>>;
}

/** Arguments of `generateMetadata()` in layouts and pages. */
export interface MetadataContext {
    params: Readonly<Record<string, string | string[] | undefined>>;
    query: Readonly<Record<string, string | string[]>>;
}

/** One rendered tag: React hoists <title>, <meta> and <link> into <head>. */
export type MetadataTag =
    | { tag: "title"; text: string }
    | { tag: "meta"; attributes: Record<string, string> }
    | { tag: "link"; attributes: Record<string, string> };

/** Merges root → leaf. Later levels win per field; `openGraph`/`twitter`/`alternates` merge one level deep. */
export function mergeMetadata(levels: readonly (Metadata | undefined)[]): { metadata: Metadata; title: string | undefined } {
    const merged: Metadata = {};
    let template: string | undefined;
    let title: string | undefined;
    for (const level of levels) {
        if (!level) continue;
        const { title: levelTitle, openGraph, twitter, alternates, ...rest } = level;
        Object.assign(merged, rest);
        if (openGraph) merged.openGraph = { ...merged.openGraph, ...openGraph };
        if (twitter) merged.twitter = { ...merged.twitter, ...twitter };
        if (alternates) merged.alternates = { ...merged.alternates, ...alternates };
        if (levelTitle !== undefined) {
            if (typeof levelTitle === "string") title = template ? template.replace("%s", levelTitle) : levelTitle;
            else if ("absolute" in levelTitle) title = levelTitle.absolute;
            else {
                title = template ? template.replace("%s", levelTitle.default) : levelTitle.default;
                if (levelTitle.template) template = levelTitle.template;
            }
        }
    }
    return { metadata: merged, title };
}

export function metadataTags(metadata: Metadata, title: string | undefined): MetadataTag[] {
    const tags: MetadataTag[] = [];
    const meta = (attributes: Record<string, string>) => tags.push({ tag: "meta", attributes });
    const link = (attributes: Record<string, string>) => tags.push({ tag: "link", attributes });

    if (title !== undefined) tags.push({ tag: "title", text: title });
    if (metadata.description) meta({ name: "description", content: metadata.description });
    if (metadata.keywords?.length) meta({ name: "keywords", content: metadata.keywords.join(", ") });
    for (const author of metadata.authors ?? []) meta({ name: "author", content: author.name });
    if (metadata.robots !== undefined) {
        const robots =
            typeof metadata.robots === "string"
                ? metadata.robots
                : [metadata.robots.index === false ? "noindex" : "index", metadata.robots.follow === false ? "nofollow" : "follow"].join(", ");
        meta({ name: "robots", content: robots });
    }
    if (metadata.themeColor) meta({ name: "theme-color", content: metadata.themeColor });
    if (metadata.alternates?.canonical) link({ rel: "canonical", href: metadata.alternates.canonical });
    for (const [lang, href] of Object.entries(metadata.alternates?.languages ?? {})) link({ rel: "alternate", hrefLang: lang, href });
    const icons = metadata.icons?.icon;
    for (const href of typeof icons === "string" ? [icons] : icons ?? []) link({ rel: "icon", href });
    if (metadata.icons?.apple) link({ rel: "apple-touch-icon", href: metadata.icons.apple });

    const og = metadata.openGraph;
    if (og) {
        const property = (name: string, content: string | undefined) => content && meta({ property: `og:${name}`, content });
        property("title", og.title ?? title);
        property("description", og.description ?? metadata.description);
        property("url", og.url);
        property("site_name", og.siteName);
        property("locale", og.locale);
        property("type", og.type);
        for (const image of og.images ?? []) {
            const value = typeof image === "string" ? { url: image } : image;
            property("image", value.url);
            if (value.width) property("image:width", String(value.width));
            if (value.height) property("image:height", String(value.height));
            if (value.alt) property("image:alt", value.alt);
        }
    }
    const twitter = metadata.twitter;
    if (twitter) {
        const name = (key: string, content: string | undefined) => content && meta({ name: `twitter:${key}`, content });
        name("card", twitter.card);
        name("site", twitter.site);
        name("creator", twitter.creator);
        name("title", twitter.title ?? title);
        name("description", twitter.description ?? metadata.description);
        for (const image of twitter.images ?? []) name("image", image);
    }
    for (const [key, content] of Object.entries(metadata.other ?? {})) meta({ name: key, content });
    return tags;
}
