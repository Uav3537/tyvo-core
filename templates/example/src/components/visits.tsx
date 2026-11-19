"use client";

import { useState } from "react";
import { api } from "@tyvo/core/client";

// api() calls route.ts endpoints with their types: the path, params, query and body are checked, and
// result.data is what the handler returns (here { session, visits } from src/app/api/session/route.ts).
export function Visits() {
    const [visits, setVisits] = useState<number>();
    const count = async () => {
        const result = await api("/api/session").GET();
        if (result.ok) setVisits(result.data.visits);
    };
    return <button onClick={count}>{visits === undefined ? "Count my visits" : `Visits: ${visits}`}</button>;
}
