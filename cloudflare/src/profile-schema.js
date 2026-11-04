import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const meta = sqliteTable("profile_meta", {
  id: integer("id").primaryKey(),
  rev: integer("revision").notNull(),
  wid: text("write_id").notNull(),
  version: integer("storage_version").notNull(),
});
export const sections = sqliteTable("profile_sections", {
  field: text("field").primaryKey(),
  position: integer("position").notNull(),
  kind: text("kind").notNull(),
});
export const fragments = sqliteTable("profile_fragments", {
  field: text("field").notNull(),
  item: integer("item_index").notNull(),
  chunk: integer("chunk_index").notNull(),
  payload: blob("payload", { mode: "buffer" }).notNull(),
}, t => [primaryKey({columns:[t.field,t.item,t.chunk]})]);
