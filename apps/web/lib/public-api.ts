import { cache } from "react";
import { getSql } from "./db";
import { getLiveApi } from "./repo/apis";

/** One read per request of a live API, shared by the /p/[apiId] layout, its pages and their metadata. */
export const loadLiveApi = cache((apiId: string) => getLiveApi(getSql(), apiId));
