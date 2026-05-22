importScripts("/kotlin/sql-wasm.js");

const workerParams = new URL(self.location.href).searchParams;
const isDebugBuild = workerParams.get("debug") === "1";
const databaseName = isDebugBuild ? "phoebe-sql-debug" : "phoebe-sql";
const storeName = "databases";
const revisionParam = workerParams.get("revision") ?? "0";
const databaseKey = isDebugBuild
    ? `phoebe-debug.db.v${revisionParam}.async`
    : `phoebe.db.v${revisionParam}.async`;

let db = null;
let transactionDepth = 0;

function openStore(mode) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(storeName);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const transaction = request.result.transaction(storeName, mode);
            resolve(transaction.objectStore(storeName));
        };
    });
}

async function readPersistedDatabase() {
    const store = await openStore("readonly");
    return new Promise((resolve, reject) => {
        const request = store.get(databaseKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || null);
    });
}

async function persistDatabase() {
    const store = await openStore("readwrite");
    const bytes = db.export();
    return new Promise((resolve, reject) => {
        const request = store.put(bytes, databaseKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
    });
}

async function createDatabase() {
    const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
    const persisted = await readPersistedDatabase();
    db = persisted ? new SQL.Database(persisted) : new SQL.Database();
}

function isWrite(sql) {
    const normalized = (sql || "").trim().toLowerCase();
    return normalized.length > 0 &&
        !normalized.startsWith("select") &&
        !normalized.startsWith("pragma") &&
        !normalized.startsWith("with");
}

async function onModuleReady() {
    const data = this.data;

    switch (data && data.action) {
        case "exec": {
            if (!data.sql) throw new Error("exec: Missing query string");
            const results = db.exec(data.sql, data.params)[0] || { values: [] };
            if (isWrite(data.sql) && transactionDepth === 0) await persistDatabase();
            return postMessage({
                id: data.id,
                results,
                rowCount: db.getRowsModified(),
            });
        }
        case "begin_transaction":
            transactionDepth += 1;
            db.exec("BEGIN TRANSACTION;");
            return postMessage({ id: data.id, results: [], rowCount: 0 });
        case "end_transaction":
            db.exec("END TRANSACTION;");
            transactionDepth = Math.max(0, transactionDepth - 1);
            await persistDatabase();
            return postMessage({ id: data.id, results: [], rowCount: 0 });
        case "rollback_transaction":
            db.exec("ROLLBACK TRANSACTION;");
            transactionDepth = Math.max(0, transactionDepth - 1);
            return postMessage({ id: data.id, results: [], rowCount: 0 });
        default:
            throw new Error(`Unsupported action: ${data && data.action}`);
    }
}

function onError(err) {
    return postMessage({
        id: this.data.id,
        error: err && (err.message || err.toString()),
    });
}

const sqlModuleReady = createDatabase();
self.onmessage = (event) => {
    return sqlModuleReady
        .then(onModuleReady.bind(event))
        .catch(onError.bind(event));
};
