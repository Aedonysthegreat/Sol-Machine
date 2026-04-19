import Database from "better-sqlite3";
import fs from "fs";

const db = new Database("sol-machine.sqlite");

const schema = fs.readFileSync("./schema.sql", "utf8");
db.exec(schema);

export default db;