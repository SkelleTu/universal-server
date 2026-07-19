import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import collectionsRouter from "./collections";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(collectionsRouter);

export default router;
