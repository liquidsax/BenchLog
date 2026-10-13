/**
 * Extension entry omp loads via `benchlog --extension <package>/benchlog-ext`.
 * The implementation stays at `.omp/tools/serial` so fixture paths and the
 * in-repo discovery path are unchanged.
 */
export { default } from "../../../.omp/tools/serial/index.ts";
