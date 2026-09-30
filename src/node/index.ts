export { createHttpAgent, createHttpsAgent, configureAxiosConnectionPool } from './agents';
export type {
  PoolConfig,
  PoolStats,
  PooledAgent,
  PoolMonitorConfig,
} from '../utils/connection-pool';
export {
  DEFAULT_POOL_CONFIG,
  getHttpAgentStats,
  monitorPoolHealth,
  destroyPoolAgent,
} from '../utils/connection-pool';
export { TrustFlowError } from '../errors';
export {
  inspectXdr,
  formatInspectedResult,
} from './inspect';
export type {
  InspectedArgument,
  InspectedAuthEntry,
  InspectedInvocation,
  InspectedOperation,
  InspectedResult,
} from './inspect';
