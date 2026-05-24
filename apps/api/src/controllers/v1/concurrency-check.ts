import {
  ConcurrencyCheckParams,
  ConcurrencyCheckResponse,
  RequestWithAuth,
} from "./types";
import { Response } from "express";
import { getRedisConnection } from "../../../src/services/queue-service";
import { autumnService } from "../../services/autumn/autumn.service";

// Basically just middleware and error wrapping
export async function concurrencyCheckController(
  req: RequestWithAuth<ConcurrencyCheckParams, undefined, undefined>,
  res: Response<ConcurrencyCheckResponse>,
) {
  const concurrencyLimiterKey = "concurrency-limiter:" + req.auth.team_id;
  const now = Date.now();
  const activeJobsOfTeam = await getRedisConnection().zrangebyscore(
    concurrencyLimiterKey,
    now,
    Infinity,
  );

  const autumnConcurrency = await autumnService.getConcurrencyLimit(
    req.auth.team_id,
    req.acuc?.org_id,
  );

  return res.status(200).json({
    success: true,
    concurrency: activeJobsOfTeam.length,
    maxConcurrency: Math.max(
      req.acuc?.concurrency ?? 2,
      autumnConcurrency ?? 0,
    ),
  });
}
