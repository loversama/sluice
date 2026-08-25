/**
 * The public surface of the mining core.
 *
 * Both distributions compose the same things from here, and only these: a host builds an
 * app, hands its `ServerContext` to a delivery layer, and never reaches past this file.
 * Deep imports are deliberately not offered - the day the server starts pulling on miner
 * internals is the day the two stop being separable.
 */

export { createApp, type AppOptions, type AppHandle } from "./app.js";
export type { ServerContext, DeviceCodeInfo } from "./api/context.js";
export {
    serializeCampaign,
    serializeDrop,
    maskConfig,
    isMasked,
} from "./api/serialize.js";
export {
    loadConfig,
    saveConfig,
    DEFAULT_CONFIG,
    type Config,
    type LibraryPolicy,
    type UnlinkedPolicy,
    type SteamProvider,
} from "./config.js";
export {
    default as logger,
    setLogLevel,
    setLogSink,
    consoleSink,
    isLevelEnabled,
    type LogLevel,
    type LogSink,
} from "./logger.js";
export { VERSION } from "./version.js";
export { buildLoginUrl, verifyCallback } from "./steam/openid.js";
export { InstanceLock, instanceLockPath, findConflictingInstance } from "./instance-guard.js";

// Types the delivery layer needs in order to describe the context it is handed, but whose
// implementations it never constructs.
export type { Miner } from "./miner.js";
export type { AuthState } from "./twitch/auth.js";
export type { NotifierGroup } from "./notifiers/index.js";
export type { SteamLibrary } from "./steam/library.js";
export type { Campaign, Drop, PriorityMode } from "./models/campaign.js";
