import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BROWSER_PROFILE } from "./paths.js";
export const IMPORT_MARKER = join(BROWSER_PROFILE, ".openxpli-imported");
export function chromeUserDataDir() {
    return process.env.OPENXPLI_CHROME_USER_DATA
        ?? join(homedir(), "Library", "Application Support", "Google", "Chrome");
}
// Chrome records which profile the user was last in. Someone with several
// profiles gets the one they actually use, not a guess at "Default".
export function chromeProfileDir(userData = chromeUserDataDir()) {
    if (process.env.OPENXPLI_CHROME_PROFILE)
        return process.env.OPENXPLI_CHROME_PROFILE;
    try {
        const state = JSON.parse(readFileSync(join(userData, "Local State"), "utf8"));
        const last = state.profile?.last_used;
        if (last && existsSync(join(userData, last)))
            return last;
    }
    catch { /* fall through to the default profile */ }
    return "Default";
}
export function profileNames(userData = chromeUserDataDir()) {
    try {
        const state = JSON.parse(readFileSync(join(userData, "Local State"), "utf8"));
        return Object.keys(state.profile?.info_cache ?? {});
    }
    catch {
        return [];
    }
}
// Caches and history: large, and irrelevant to being signed in.
const BULK = [
    "File System", "Service Worker", "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache",
    "DawnWebGPUCache", "Shared Dictionary", "BrowserMetrics", "component_crx_cache",
    "History", "History-journal", "Top Sites", "Top Sites-journal", "Favicons",
    "Favicons-journal", "Visited Links", "Extensions", "Extension State", "Extension Rules",
];
// Saved passwords, cards and addresses. Sessions come from cookies and storage,
// so these are never needed — and copying them would widen what a browser
// automation tool can reach for no benefit.
const SECRETS = [
    "Login Data", "Login Data-journal", "Login Data For Account", "Login Data For Account-journal",
    "Web Data", "Web Data-journal", "Account Web Data", "Account Web Data-journal",
    "Affiliation Database", "Affiliation Database-journal", "AutofillStrikeDatabase",
];
// A point-in-time clone of the user's signed-in profile. Chrome binds cookie
// encryption to the machine keychain, not to the directory, so a full copy
// decrypts — which is why the tool inherits every sign-in the user already has.
// A partial copy does not: Chrome treats it as a new profile and clears it.
export function importChromeProfile(opts = {}) {
    const userData = opts.userData ?? chromeUserDataDir();
    const profile = opts.profile ?? chromeProfileDir(userData);
    const source = join(userData, profile);
    if (!existsSync(source))
        throw new Error(`No Chrome profile at ${source}. Profiles found: ${profileNames(userData).join(", ") || "none"}. Set OPENXPLI_CHROME_PROFILE to pick one.`);
    if (existsSync(IMPORT_MARKER) && !opts.force)
        throw new Error(`${BROWSER_PROFILE} was already imported. Pass --force to replace it (any sign-ins made only in the OpenXPLI browser are lost).`);
    mkdirSync(join(BROWSER_PROFILE, profile === "Default" ? "Default" : "Default"), { recursive: true });
    const excludes = [...BULK, ...SECRETS].flatMap((name) => ["--exclude", name]);
    // The clone always lands in "Default": Chrome opens that profile by default,
    // so the OpenXPLI browser needs no --profile-directory to find it.
    const run = spawnSync("rsync", ["-a", "--delete", ...excludes, `${source}/`, `${join(BROWSER_PROFILE, "Default")}/`], { encoding: "utf8" });
    if (run.status !== 0)
        throw new Error(`Copying the profile failed: ${(run.stderr || run.error?.message || "unknown error").slice(0, 300)}`);
    const state = spawnSync("cp", [join(userData, "Local State"), join(BROWSER_PROFILE, "Local State")], { encoding: "utf8" });
    if (state.status !== 0)
        throw new Error(`Copying Local State failed: ${(state.stderr || "unknown error").slice(0, 300)}`);
    // A stale lock from the source profile stops Chrome opening the clone.
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
        rmSync(join(BROWSER_PROFILE, lock), { force: true });
    const du = spawnSync("du", ["-sk", BROWSER_PROFILE], { encoding: "utf8" });
    const bytes = Number((du.stdout ?? "0").trim().split(/\s+/)[0] || 0) * 1024;
    writeFileSync(IMPORT_MARKER, JSON.stringify({ from: source, at: Date.now() }, null, 2));
    return { from: source, profile, to: BROWSER_PROFILE, bytes };
}
