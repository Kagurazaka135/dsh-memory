import { DEFAULT_CONFIG } from "./config.js";
import { serviceOf } from "./host.js";
import { cleanupNightlyOrganize, setupNightlyOrganize } from "./schedule.js";
import { resolvePaths } from "./store.js";
import { registerMemoryTools } from "./tools.js";
export const name = 'dsh-memory';
/** 硬依赖：没有 tools 服务就什么也注册不了。其余（sessions/schedule/sessionQuery/sessionPersistence）都是可选能力。 */
export const inject = ['tools'];
export function apply(ctx, config) {
    const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const logger = serviceOf(ctx, 'logger');
    registerMemoryTools(ctx, { config: merged, paths: resolvePaths(merged), ctx });
    logger?.info(`dsh-memory: 记忆工具已注册（memory 目录：$DSH_HOME/memory${merged.memory_dir ? `，覆盖为 ${merged.memory_dir}` : ''}）`);
    if (merged.enable_schedule === false) {
        // 显式停用：主动清掉自己注册过的任务（幂等；没注册过则 no-op）。
        ctx.inject(['schedule'], (sctx) => {
            void cleanupNightlyOrganize(sctx, merged).catch((error) => {
                const log = serviceOf(sctx, 'logger');
                log?.warn(`dsh-memory: 清理夜间整理任务异常（忽略）：${error instanceof Error ? error.message : String(error)}`);
            });
        });
        return;
    }
    // 可选依赖：sessions/schedule 齐全时才尝试自动注册夜间整理；sessionQuery/sessionPersistence
    // 各自按需取用（sessionQuery 用于扫会话，sessionPersistence 用于物化整理会话）。
    // 缺 schedule（如 dsh 0.1.x）则静默维持 pending，不影响已注册的工具。
    ctx.inject(['sessions', 'schedule'], (sctx) => {
        void setupNightlyOrganize(sctx, merged).catch((error) => {
            const log = serviceOf(sctx, 'logger');
            log?.warn(`dsh-memory: 自动注册夜间整理异常（忽略）：${error instanceof Error ? error.message : String(error)}`);
        });
    });
}
