import Database from "better-sqlite3";
import fs from "fs";

/*
  Open (or create) the SQLite database file.
  This is the single database used by the backend.
*/
const db = new Database("sol-machine.sqlite");

/*
  Turn on foreign key enforcement.
  SQLite does not enforce foreign keys unless this pragma is enabled.
*/
db.pragma("foreign_keys = ON");

/*
  Read the schema file from disk.
  This lets the app create missing tables automatically on startup.
*/
const schema = fs.readFileSync("./schema.sql", "utf8");

/*
  Execute the schema.
  CREATE TABLE IF NOT EXISTS means:
  - if the tables already exist, nothing breaks
  - if they do not exist, they are created
*/
db.exec(schema);

/*
  Export the database instance so the rest of the app can use it.
*/
export default db;