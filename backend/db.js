import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || "./data/sol-machine.sqlite";

const dbDir = path.dirname(DB_PATH);
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

db.pragma("foreign_keys = ON");

const schema = fs.readFileSync("./schema.sql", "utf8");
db.exec(schema);

export default db;