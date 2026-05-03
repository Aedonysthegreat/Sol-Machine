import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH || "./data/sol-machine.sqlite";

const dbDir = path.dirname(DB_PATH);
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

db.pragma("foreign_keys = ON");

const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

db.exec(schema);

export default db;