import { pgTable, serial, varchar, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  api_key: varchar("api_key", { length: 64 }).unique().notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

export const collectionsTable = pgTable(
  "collections",
  {
    id: serial("id").primaryKey(),
    project_id: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }),
    collection: varchar("collection", { length: 255 }).notNull(),
    data: jsonb("data").notNull().default({}),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_collections_project").on(table.project_id, table.collection)],
);

export const requestLogsTable = pgTable(
  "request_logs",
  {
    id: serial("id").primaryKey(),
    project_id: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }),
    method: varchar("method", { length: 10 }),
    endpoint: text("endpoint"),
    status: integer("status"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [index("idx_logs_project").on(table.project_id)],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, api_key: true, created_at: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
export type Collection = typeof collectionsTable.$inferSelect;
export type RequestLog = typeof requestLogsTable.$inferSelect;
