import express, { type Express } from "express";
import { prisma } from "../lib/prisma.ts";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: "connected" });
    } catch {
      res.status(503).json({ status: "degraded", db: "disconnected" });
    }
  });

  return app;
}
