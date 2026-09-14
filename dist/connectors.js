import { openDb } from "./db.js";
import { activeLearningJob } from "./learning-jobs.js";
export function deleteConnector(id, confirmed) {
    if (typeof id !== "string" || !id.trim())
        throw new Error("Choose a connector to delete");
    if (confirmed !== true)
        throw new Error("Confirm connector deletion first");
    activeLearningJob(id); // Recover interrupted workers before checking for active work.
    const db = openDb();
    try {
        return db.transaction(() => {
            if (!db.prepare("SELECT 1 FROM processes WHERE id = ?").get(id))
                throw new Error("No such connector");
            if (db.prepare("SELECT 1 FROM learning_jobs WHERE source_id = ? AND status IN ('queued','running')").get(id))
                throw new Error("Cancel the browser task and wait for it to stop before deleting this connector.");
            if (db.prepare("SELECT 1 FROM kits WHERE process_id = ? AND state IN ('queued','preparing')").get(id))
                throw new Error("Wait for kit preparation to finish before deleting this connector.");
            if (db.prepare("SELECT 1 FROM experiments WHERE process_id = ? AND status IN ('running','launching')").get(id)
                || db.prepare("SELECT 1 FROM holdouts WHERE process_id = ? AND status = 'validating'").get(id))
                throw new Error("Stop the active experiment or holdout before deleting this connector.");
            db.prepare("DELETE FROM observations WHERE experiment_id IN (SELECT id FROM experiments WHERE process_id = ?)").run(id);
            for (const table of ["outcomes", "holdouts", "kits", "experiments"])
                db.prepare(`DELETE FROM ${table} WHERE process_id = ?`).run(id);
            for (const table of ["learning_jobs", "knowledge", "candidates", "goals"])
                db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(id);
            db.prepare("DELETE FROM processes WHERE id = ?").run(id);
            return `Deleted connector ${id}`;
        }).immediate();
    }
    finally {
        db.close();
    }
}
