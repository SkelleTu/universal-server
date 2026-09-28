import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import collectionsRouter from "./collections";
import gameRouter from "./game";
import weatherRouter from "./weather";
import googleRouter from "./google";
import playerStateRouter from "./player-state";
import multiplayerRouter from "./multiplayer";
import authRouter from "./auth";
import integrateSystemRouter from "./integratesystem";
import supremeRouter from "./supreme";
import agentRouter from "./agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(collectionsRouter);
router.use(gameRouter);
router.use(weatherRouter);
router.use(googleRouter);
router.use(playerStateRouter);
router.use(multiplayerRouter);
router.use(authRouter);
// Delegated IntegrateSystem actions must be registered before the generic agent route.
router.use(integrateSystemRouter);
// The existing Aurora bridge enters through this single Supreme operator gate.
router.use(supremeRouter);
router.use(agentRouter);

export default router;
