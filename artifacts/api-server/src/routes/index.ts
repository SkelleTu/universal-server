import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import collectionsRouter from "./collections";
import gameRouter from "./game";
import weatherRouter from "./weather";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(collectionsRouter);
router.use(gameRouter);
router.use(weatherRouter);

export default router;
