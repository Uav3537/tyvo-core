"use server";

// Every export of a "use server" module is a server action: callable from client components,
// always executed on the server. Arguments and return values must be serializable.
let likes = 0;

export async function getLikes(): Promise<number> {
    return likes;
}

export async function like(): Promise<number> {
    likes += 1;
    return likes;
}
