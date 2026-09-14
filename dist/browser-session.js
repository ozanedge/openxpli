import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
export class BrowserCancelled extends Error {
    constructor() { super("Browser task cancelled. Your account has not been changed."); }
}
export class BrowserBusy extends Error {
    constructor() { super("The saved browser session is still in use. Close the OpenXPLI sign-in window, then retry. Other Chrome windows can stay open."); }
}
export function processAlive(pid) {
    if (!pid || !Number.isInteger(pid) || pid < 1)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// All persistent contexts, including scheduled reads, share this FIFO queue.
// A live owner is never evicted merely because a wall-clock timeout elapsed.
export async function acquireBrowser(options = {}) {
    const db = openDb(), id = randomUUID();
    db.prepare("INSERT INTO browser_requests (id, pid, created_at) VALUES (?,?,?)").run(id, process.pid, Date.now());
    const release = () => {
        const connection = openDb();
        try {
            connection.prepare("DELETE FROM browser_requests WHERE id = ?").run(id);
        }
        finally {
            connection.close();
        }
    };
    const started = Date.now();
    try {
        for (;;) {
            if (options.cancelled?.())
                throw new BrowserCancelled();
            const first = db.transaction(() => {
                const requests = db.prepare("SELECT id, pid FROM browser_requests ORDER BY sequence").all();
                for (const request of requests)
                    if (!processAlive(request.pid))
                        db.prepare("DELETE FROM browser_requests WHERE id = ?").run(request.id);
                return db.prepare("SELECT id FROM browser_requests ORDER BY sequence LIMIT 1").get();
            }).immediate();
            if (first?.id === id)
                return release;
            options.onWaiting?.(false);
            if (Date.now() - started >= (options.timeoutMs ?? 15 * 60_000))
                throw new BrowserBusy();
            await delay(options.pollMs ?? 1000);
        }
    }
    catch (e) {
        release();
        throw e;
    }
    finally {
        db.close();
    }
}
export function profileInUse(error) {
    return /ProcessSingleton|SingletonLock|profile.*(?:in use|already used)|user data directory is already in use/i.test(String(error));
}
export async function openBrowserSession(launch, options = {}) {
    const release = await acquireBrowser(options);
    let closed = false;
    const once = () => { if (!closed) {
        closed = true;
        release();
    } };
    try {
        if (options.cancelled?.())
            throw new BrowserCancelled();
        let context;
        try {
            context = await launch();
        }
        catch (e) {
            // Relaunching a busy profile can send new tabs to the existing Chrome.
            // Never use Chrome launch as a polling mechanism; require an explicit retry.
            if (profileInUse(e))
                throw new BrowserBusy();
            throw e;
        }
        context.once("close", once);
        if (options.cancelled?.()) {
            await context.close();
            throw new BrowserCancelled();
        }
        options.onOpened?.();
        return context;
    }
    catch (e) {
        once();
        throw e;
    }
}
// beforeClose runs while the tab is still alive, so the sign-in can be
// acknowledged on screen before the window it is shown in goes away.
export async function finishSignin(session, options = {}) {
    await new Promise((resolve, reject) => {
        let finished = false;
        const settle = (error) => {
            if (finished)
                return;
            finished = true;
            clearInterval(timer);
            session.page.off?.("close", onPageClose);
            error ? reject(error) : resolve();
        };
        let closing = false;
        const done = async (error) => {
            if (closing)
                return;
            closing = true;
            if (!error) {
                try {
                    await options.beforeClose?.();
                }
                catch { /* the tab may already be gone */ }
            }
            try {
                await session.close();
            }
            catch { /* the tab may already be gone */ }
            settle(error);
        };
        const onPageClose = () => { void done(options.cancelled?.() ? new BrowserCancelled() : undefined); };
        const timer = setInterval(() => {
            try {
                if (options.cancelled?.())
                    void done(new BrowserCancelled());
                else if (options.continued?.())
                    void done();
            }
            catch (e) {
                void done(e instanceof Error ? e : new Error("Sign-in status could not be read"));
            }
        }, options.pollMs ?? 500);
        session.page.on("close", onPageClose);
        if (session.page.isClosed?.())
            void done();
    });
}
